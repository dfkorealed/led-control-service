import { Injectable, Optional } from "@nestjs/common";
import { acceptanceAckV2Schema, deriveDeviceStatusAckStatus, deviceStatusAckV2Schema } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { PrismaService } from "../prisma/prisma.service";
import { CommandSafetyDigest } from "./command-safety-digest";
import { stageTerminalSetFences } from "./command-late-set-receipt";

type WireIdentity = { dispatchId: string; commandId: string; gatewayId: string; idempotencyKey: string;
  sequence: number; siteId: string };
type DeviceAck = ReturnType<typeof deviceStatusAckV2Schema.parse>;
type AcceptanceAck = ReturnType<typeof acceptanceAckV2Schema.parse>;
const ACTIVE = ["pending", "published", "accepted"];
const TERMINAL = ["completed", "failed", "timed_out"];

/** Recovery Get ACKs do not join Command or CommandDispatch; those rows may be gone. */
@Injectable()
export class CommandRecoveryAckService {
  constructor(private readonly prisma: PrismaService, private readonly snapshot: AutomationSnapshotService,
    @Optional() private readonly digest?: CommandSafetyDigest) {}

  async tryStoreAcceptanceAck(ack: AcceptanceAck): Promise<boolean> {
    if (!await this.isRecoveryDispatch(ack.dispatchId)) return false;
    await this.prisma.$transaction(async (tx) => {
      await this.snapshot.lockMutation(tx);
      const locked = await lockExactRecoveryDispatch(tx, ack);
      if (!locked) return;
      const dispatch = await tx.recoveryDispatch.findUnique({ where: { id: ack.dispatchId } });
      if (!dispatch || !ACTIVE.includes(dispatch.status)) return;
      const acceptedAt = new Date(ack.acceptedAt);
      const acceptedReceivedAt = new Date();
      if (ack.status === "accepted") {
        await tx.recoveryDispatch.updateMany({ where: { id: dispatch.id, status: { in: ["pending", "published"] } },
          data: { status: "accepted", acceptedAt, acceptedReceivedAt } });
        return;
      }
      const updated = await tx.recoveryDispatch.updateMany({ where: { id: dispatch.id, status: dispatch.status },
        data: { status: "failed", acceptedAt, acceptedReceivedAt, completedAt: acceptedReceivedAt,
          errorCode: ack.errorCode ?? "GATEWAY_REJECTED" } });
      if (updated.count === 1) await this.finishAttempt(tx, locked.holdId, dispatch.verificationAttempt);
    });
    return true;
  }

  async tryStoreDeviceStatusAck(ack: DeviceAck): Promise<boolean> {
    if (!await this.isRecoveryDispatch(ack.dispatchId)) return false;
    await this.prisma.$transaction(async (tx) => {
      await this.snapshot.lockMutation(tx);
      const locked = await lockExactRecoveryDispatch(tx, ack);
      if (!locked) return;
      const dispatch = await tx.recoveryDispatch.findUnique({ where: { id: ack.dispatchId },
        include: { targets: true } });
      if (!dispatch || !ACTIVE.includes(dispatch.status)) return;

      const expectedIds = new Set(dispatch.targets.map(({ fixtureId }) => fixtureId));
      const actualIds = new Set(ack.results.map(({ fixtureId }) => fixtureId));
      if (expectedIds.size !== dispatch.targets.length || actualIds.size !== ack.results.length
        || expectedIds.size !== actualIds.size || [...expectedIds].some((id) => !actualIds.has(id))) {
        await this.failChunk(tx, dispatch.id, dispatch.status, locked.holdId, dispatch.verificationAttempt,
          "ACK_FIXTURE_SET_MISMATCH");
        return;
      }
      if (deriveDeviceStatusAckStatus(ack.results) !== ack.status) {
        await this.failChunk(tx, dispatch.id, dispatch.status, locked.holdId, dispatch.verificationAttempt,
          "ACK_STATUS_MISMATCH");
        return;
      }
      // Preserve the legacy STATUS_TIMEOUT compatibility only after validating
      // the original aggregate and exact chunk membership.
      const results = ack.results.map((result) => result.status === "failed" && result.faultCode === "STATUS_TIMEOUT"
        ? { ...result, status: "timed_out" as const, brightness: undefined } : result);
      const status = deriveDeviceStatusAckStatus(results) === "succeeded" ? "completed"
        : deriveDeviceStatusAckStatus(results) === "timed_out" ? "timed_out" : "failed";
      const completedAt = new Date(ack.occurredAt);
      const updated = await tx.recoveryDispatch.updateMany({ where: { id: dispatch.id, status: dispatch.status },
        data: { status, completedAt, errorCode: status === "completed" ? null : "VERIFICATION_INCOMPLETE" } });
      if (updated.count !== 1) return;
      for (const result of results) {
        const written = await tx.recoveryDispatchTarget.updateMany({ where: {
          dispatchId: dispatch.id, fixtureId: result.fixtureId
        }, data: { status: result.status, brightness: result.status === "succeeded" ? result.brightness ?? null : null,
          observedAt: completedAt } });
        if (written.count !== 1) throw new Error("recovery ACK target left exact dispatch scope");
      }
      await this.finishAttempt(tx, locked.holdId, dispatch.verificationAttempt);
    });
    return true;
  }

  private async isRecoveryDispatch(dispatchId: string) {
    return !!await this.prisma.recoveryDispatch.findUnique({ where: { id: dispatchId }, select: { id: true } });
  }

  private async failChunk(tx: Prisma.TransactionClient, dispatchId: string, currentStatus: string,
    holdId: string, attempt: number, errorCode: string) {
    const updated = await tx.recoveryDispatch.updateMany({ where: { id: dispatchId, status: currentStatus },
      data: { status: "failed", completedAt: new Date(), errorCode } });
    if (updated.count === 1) await this.finishAttempt(tx, holdId, attempt);
  }

  private async finishAttempt(tx: Prisma.TransactionClient, holdId: string, attempt: number) {
    const dispatches = await tx.recoveryDispatch.findMany({ where: { holdId, verificationAttempt: attempt },
      include: { targets: true } });
    if (dispatches.length === 0 || dispatches.some((dispatch) => !TERMINAL.includes(dispatch.status))) return;
    const observations = dispatches.flatMap((dispatch) => dispatch.targets);
    const hold = await tx.unresolvedCommandHold.findUnique({ where: { id: holdId },
      include: { targets: true } });
    if (!hold) return;
    const expectedIds = new Set(hold.targets.map(({ fixtureId }) => fixtureId));
    const observedIds = new Set(observations.map(({ fixtureId }) => fixtureId));
    const complete = dispatches.every((dispatch) => dispatch.status === "completed")
      && expectedIds.size === hold.targets.length && observedIds.size === observations.length
      && expectedIds.size === observedIds.size && [...expectedIds].every((id) => observedIds.has(id))
      && observations.every((observation) => observation.status === "succeeded" && observation.brightness !== null);
    if (!complete) {
      await tx.unresolvedCommandHold.updateMany({ where: { id: holdId }, data: { lastCheckedAt: new Date() } });
      return;
    }
    // Every physical fixture was observed; agreement with the old Set target is
    // not required to release uncertainty. Mixed observed values are verified
    // partial, not a fabricated all-applied result. The bounded summary is
    // written before deleting the hold and its detailed Get receipts.
    const expectedById = new Map(hold.targets.map((target) => [target.fixtureId, target.expectedBrightness]));
    const matching = observations.filter((result) => result.brightness === expectedById.get(result.fixtureId)).length;
    const verifiedOutcome = matching === observations.length ? "verified_applied"
      : matching === 0 ? "verified_not_applied" : "verified_partial";
    if (process.env.COMMAND_LATE_SET_TERMINAL_FENCE_ENABLED === "1") {
      if (!this.digest) throw new Error("late Set terminal fence signer unavailable");
      await stageTerminalSetFences(tx, hold.id, hold.siteId, this.digest);
    }
    await tx.resolvedCommandRecovery.create({ data: { id: hold.id, siteId: hold.siteId,
      classification: verifiedOutcome, targetCount: observations.length } });
    await tx.unresolvedCommandHold.deleteMany({ where: { id: holdId, siteId: hold.siteId } });
  }
}

async function lockExactRecoveryDispatch(tx: Prisma.TransactionClient, ack: WireIdentity) {
  const rows = await tx.$queryRaw<Array<{ id: string; holdId: string }>>(Prisma.sql`
    SELECT d."id", d."holdId"
    FROM "RecoveryDispatch" AS d
    INNER JOIN "UnresolvedCommandHold" AS h ON h."id" = d."holdId"
    WHERE d."id" = ${ack.dispatchId} AND d."gatewayId" = ${ack.gatewayId}
      AND d."idempotencyKey" = ${ack.idempotencyKey} AND d."sequence" = ${BigInt(ack.sequence)}
      AND h."siteId" = ${ack.siteId} AND h."originalCommandId" = ${ack.commandId}
    FOR UPDATE OF d, h
  `);
  return rows[0] ?? null;
}
