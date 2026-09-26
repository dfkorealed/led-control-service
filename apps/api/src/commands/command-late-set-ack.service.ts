import { Injectable } from "@nestjs/common";
import { deriveDeviceStatusAckStatus, deviceStatusAckV2Schema } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { PrismaService } from "../prisma/prisma.service";
import { CommandSafetyDigest, CommandSafetyKeyUnavailableError } from "./command-safety-digest";
import { stageTerminalSetFences } from "./command-late-set-receipt";

type DeviceAck = ReturnType<typeof deviceStatusAckV2Schema.parse>;

/** Late original Set evidence after its Command/dispatch rows have been purged. */
@Injectable()
export class CommandLateSetAckService {
  constructor(private readonly prisma: PrismaService, private readonly snapshot: AutomationSnapshotService,
    private readonly digest: CommandSafetyDigest) {}

  async tryStoreDeviceStatusAck(ack: DeviceAck): Promise<boolean> {
    // Receipt ownership is checked before the legacy Command path. A forged
    // packet for an owned dispatch is consumed but cannot mutate either path.
    const owner = await this.prisma.lateSetReceipt.findUnique({ where: { originalDispatchId: ack.dispatchId },
      select: { id: true } });
    if (!owner) {
      // The normal no-key deployment keeps legacy behavior. Guarded retention
      // requires this flag/keyring before a resolved hold may lose its raw
      // receipt. A keyed match consumes any duplicate/malformed payload; it
      // cannot resurrect a case or touch a newer Command.
      if (process.env.COMMAND_LATE_SET_TERMINAL_FENCE_ENABLED !== "1") return false;
      const versions = this.digest.signAll("late-set-dispatch", [ack.dispatchId]);
      if (await this.prisma.lateSetTerminalFence.count({ where: {
        keyVersion: { notIn: versions.map(row => row.keyVersion) }
      } }) > 0) throw new CommandSafetyKeyUnavailableError("command safety HMAC key unavailable");
      return !!await this.prisma.lateSetTerminalFence.findFirst({ where: {
        dispatchDigest: { in: versions.map(row => row.value) }
      }, select: { id: true } });
    }
    await this.prisma.$transaction(async (tx) => {
      await this.snapshot.lockMutation(tx);
      const rows = await tx.$queryRaw<Array<{ id: string; holdId: string }>>(Prisma.sql`
        SELECT r."id", r."holdId" FROM "LateSetReceipt" AS r
        INNER JOIN "UnresolvedCommandHold" AS h ON h."id" = r."holdId"
        WHERE r."originalDispatchId" = ${ack.dispatchId}
          AND h."siteId" = ${ack.siteId} AND h."gatewayId" = ${ack.gatewayId}
          AND h."originalCommandId" = ${ack.commandId}
        FOR UPDATE OF r, h
      `);
      if (rows.length !== 1) return;
      const receipt = await tx.lateSetReceipt.findUnique({ where: { originalDispatchId: ack.dispatchId } });
      const hold = await tx.unresolvedCommandHold.findUnique({ where: { id: rows[0].holdId },
        include: { targets: true } });
      if (!receipt || !hold) return;
      if (!this.digest.verify("late-set-wire", [ack.siteId, ack.gatewayId, ack.commandId,
        ack.dispatchId, ack.idempotencyKey, String(ack.sequence)],
      { keyVersion: receipt.keyVersion, value: receipt.wireDigest })) return;

      const expected = readTargetSnapshot(receipt.targetFixtureIds);
      const holdTargets = new Map(hold.targets.map((target) => [target.fixtureId, target.expectedBrightness]));
      const actual = new Set(ack.results.map(({ fixtureId }) => fixtureId));
      if (!expected || expected.length !== hold.targets.length || expected.some((id) => !holdTargets.has(id))
        || actual.size !== ack.results.length || expected.length !== actual.size
        || expected.some((id) => !actual.has(id)) || deriveDeviceStatusAckStatus(ack.results) !== ack.status) return;

      // A late result with any missing/failed/timeout observation does not prove
      // the old Set's physical effect. Keep the hold and allow a fresh Get.
      if (ack.results.some((result) => result.status !== "succeeded" || result.brightness === undefined)) {
        await tx.unresolvedCommandHold.updateMany({ where: { id: hold.id }, data: { lastCheckedAt: new Date() } });
        return;
      }
      const matching = ack.results.filter((result) =>
        result.brightness === holdTargets.get(result.fixtureId)).length;
      const classification = matching === ack.results.length ? "verified_applied"
        : matching === 0 ? "verified_not_applied" : "verified_partial";
      if (process.env.COMMAND_LATE_SET_TERMINAL_FENCE_ENABLED === "1") {
        await stageTerminalSetFences(tx, hold.id, hold.siteId, this.digest);
      }
      await tx.resolvedCommandRecovery.create({ data: { id: hold.id, siteId: hold.siteId,
        classification, targetCount: ack.results.length } });
      await tx.unresolvedCommandHold.deleteMany({ where: { id: hold.id, siteId: hold.siteId } });
    });
    return true;
  }
}

function readTargetSnapshot(value: Prisma.JsonValue): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000
    || value.some((item) => typeof item !== "string") || new Set(value).size !== value.length) return null;
  return value as string[];
}
