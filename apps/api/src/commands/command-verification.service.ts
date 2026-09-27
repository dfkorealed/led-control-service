import { BadRequestException, ConflictException, GoneException, Injectable, NotFoundException } from "@nestjs/common";
import { gatewayStatusCheckCommandDraftV2Schema, mqttTopicsV2 } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "../access/site-access.service";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { AutomationClock } from "../automation/automation-clock";
import { commandHistoryGetDbClockRequested, commandHistoryGetReadBoundary } from "./command-history-rollout";

@Injectable()
export class CommandVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService,
    private readonly automationSnapshot: AutomationSnapshotService,
    private readonly clock: AutomationClock
  ) {}

  async requestStatusCheck(user: AuthenticatedUser, commandId: string, input: { clientRequestId: string }) {
    const scopedCommand = await this.prisma.command.findUnique({
      where: { id: commandId }, select: { siteId: true, createdAt: true, contentRedactedAt: true }
    });
    if (!scopedCommand) throw new NotFoundException("command not found");

    try {
      await this.siteAccess.assert(user, scopedCommand.siteId, "control");
      if (scopedCommand.contentRedactedAt) throw new GoneException({ code: "command_expired" });
      return await this.prisma.$transaction(async (tx) => {
        await this.automationSnapshot.lockMutation(tx);
        await this.siteAccess.assertControlInTransaction(tx, user, scopedCommand.siteId);
        // ACK/timeout writers lock dispatches before updating their command. Match that order
        // while the automation lock serializes competing verification/dimming requests.
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "CommandDispatch" WHERE "commandId" = ${commandId} ORDER BY "id" FOR UPDATE
        `);
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "Command" WHERE "id" = ${commandId} FOR UPDATE
        `);
        const command = await tx.command.findUnique({
          where: { id: commandId }, include: { dispatches: { orderBy: [{ createdAt: "asc" }, { sequence: "asc" }] } }
        });
        if (!command || command.siteId !== scopedCommand.siteId) throw new NotFoundException("command not found");
        if (command.contentRedactedAt || (commandHistoryGetDbClockRequested()
          && command.createdAt < (await commandHistoryGetReadBoundary(tx, scopedCommand.siteId)).retainedFrom)) {
          throw new GoneException({ code: "command_expired" });
        }

        const existing = await tx.commandDispatch.findUnique({ where: { clientRequestId: input.clientRequestId } });
        if (existing) {
          if (existing.commandId !== command.id || existing.kind !== "status_check") {
            throw new ConflictException({ code: "client_request_id_payload_conflict" });
          }
          // HTTP response recovery remains idempotent even after the physical result converged.
          return statusCheckResponse(command.dispatches.filter((dispatch) =>
            dispatch.kind === "status_check" && dispatch.verificationAttempt === existing.verificationAttempt
          ));
        }
        if (command.outcome !== "unknown") {
          throw new ConflictException({ code: "command_outcome_not_unknown" });
        }
        const checks = command.dispatches.filter((dispatch) => dispatch.kind === "status_check");
        if (checks.some((dispatch) => ["pending", "published", "accepted"].includes(dispatch.status))) {
          throw new ConflictException({ code: "status_check_in_progress" });
        }
        const verificationAttempt = Math.max(0, ...checks.map((dispatch) => dispatch.verificationAttempt ?? 0)) + 1;
        if (verificationAttempt > 3) throw new ConflictException({ code: "status_check_attempts_exhausted" });

        const originalDispatches = command.dispatches.filter((dispatch) => dispatch.kind === "dimming");
        const gatewayId = originalDispatches[0]?.gatewayId;
        if (!gatewayId || originalDispatches.some((dispatch) => dispatch.gatewayId !== gatewayId)) {
          throw new BadRequestException("command does not have a single gateway");
        }
        if (!Array.isArray(command.targetFixtureIds) || command.targetFixtureIds.length === 0
          || command.targetFixtureIds.some((id) => typeof id !== "string")
          || new Set(command.targetFixtureIds).size !== command.targetFixtureIds.length) {
          throw new BadRequestException("invalid command fixture snapshot");
        }
        const fixtureIds = (command.targetFixtureIds as string[]).slice().sort();
        const dispatches = [];
        // The wire limits each Get to 64 fixtures, while a floor/group Set can contain
        // 1,000. All chunks belong to one attempt; only its first dispatch owns the HTTP key.
        for (let offset = 0; offset < fixtureIds.length; offset += 64) {
          const gateway = await tx.gateway.update({
            where: { id: gatewayId }, data: { nextCommandSequence: { increment: 1 } },
            select: { id: true, siteId: true, nextCommandSequence: true }
          });
          if (gateway.siteId !== command.siteId) throw new BadRequestException("gateway does not belong to command site");
          const sequence = Number(gateway.nextCommandSequence);
          if (!Number.isSafeInteger(sequence)) throw new Error("gateway command sequence exceeded safe integer range");

          const dispatchId = randomUUID();
          const idempotencyKey = randomUUID();
          const payload = gatewayStatusCheckCommandDraftV2Schema.parse({
            commandId: command.id, originalCommandId: command.id, dispatchId, idempotencyKey,
            sequence, siteId: command.siteId, gatewayId, targetFixtureIds: fixtureIds.slice(offset, offset + 64),
            expectedBrightness: command.brightness, verificationAttempt, requestedAt: this.clock.now().toISOString()
          });
          const dispatch = await tx.commandDispatch.create({ data: {
            id: dispatchId, commandId: command.id, gatewayId, kind: "status_check", verificationAttempt,
            clientRequestId: offset === 0 ? input.clientRequestId : null, idempotencyKey, sequence,
            deliveryMode: payload.targetFixtureIds.length === 1 ? "unicast" : "parallel_unicast"
          } });
          await tx.commandFixtureResult.createMany({ data: payload.targetFixtureIds.map((fixtureId) => ({ dispatchId: dispatch.id, fixtureId })) });
          await tx.mqttOutbox.create({ data: {
            dispatchId: dispatch.id, topic: mqttTopicsV2.gatewayCommand(command.siteId, gatewayId, "status-check"), payload
          } });
          dispatches.push(dispatch);
        }
        return statusCheckResponse(dispatches);
      });
    } catch (error) {
      if (error instanceof NotFoundException) throw new NotFoundException("command not found");
      throw error;
    }
  }
}

function statusCheckResponse(dispatches: Array<{ id: string; commandId: string; verificationAttempt: number | null }>) {
  const dispatch = dispatches[0];
  return {
    dispatchId: dispatch.id,
    dispatchIds: dispatches.map(({ id }) => id),
    verificationAttempt: dispatch.verificationAttempt,
    terminalStatusUrl: `/commands/${dispatch.commandId}`
  };
}
