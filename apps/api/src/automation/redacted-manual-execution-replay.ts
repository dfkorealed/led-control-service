import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { automationExecutionActionResultPayloadV1Schema, automationExecutionIngestedAckV1Schema,
  mqttTopics, type AutomationExecutionEventV1 } from "@led-control/shared";
import { CommandSafetyDigest } from "../commands/command-safety-digest";
import { canonicalExecutionPayloadHash } from "./automation-mqtt-consumer.service";

/** Caller has authenticated and locked the current Gateway in this transaction.
 * Only exact keyed replay may produce a transient ACK; no raw outbox is written. */
export async function acknowledgeRedactedManualReplay(tx: Prisma.TransactionClient,
  scope: { siteId: string; gatewayId: string }, event: AutomationExecutionEventV1) {
  const execution = await tx.automationExecution.findUnique({ where: {
    gatewayId_eventId_sequence: { gatewayId: scope.gatewayId, eventId: event.eventId, sequence: BigInt(event.sequence) }
  }, select: { contentRedactedAt: true } });
  if (!execution?.contentRedactedAt) {
    const payload = event.kind === "action_result"
      ? automationExecutionActionResultPayloadV1Schema.parse(event.payload) : null;
    if (payload?.sourceType === "manual_override") {
      const source = await tx.manualOverride.findFirst({ where: {
        siteId: scope.siteId, gatewayId: scope.gatewayId, contentRedactedAt: { not: null },
        OR: [{ id: payload.sourceId }, { commandId: payload.sourceId }]
      }, select: { contentRedactedAt: true } });
      if (source?.contentRedactedAt) throw unavailable();
    }
    return;
  }
  const receipt = await tx.manualExecutionReplayReceipt.findUnique({ where: {
    gatewayId_eventId_sequence: { gatewayId: scope.gatewayId, eventId: event.eventId, sequence: BigInt(event.sequence) }
  } });
  if (!receipt) throw unavailable();
  const reportPayloadHash = canonicalExecutionPayloadHash(event);
  let exact = false;
  try {
    exact = receipt.siteId === scope.siteId && new CommandSafetyDigest().verify("manual-execution-full-event",
      [scope.siteId, scope.gatewayId, event.eventId, String(event.sequence), reportPayloadHash],
      { keyVersion: receipt.keyVersion, value: receipt.eventDigest });
  } catch { throw unavailable(); }
  if (!exact) throw new BadRequestException("automation execution replay conflict");
  const acknowledgement = automationExecutionIngestedAckV1Schema.parse({ schemaVersion: 1,
    gatewayId: scope.gatewayId, eventId: event.eventId, sequence: event.sequence,
    reportPayloadHash, ingestedAt: receipt.ackIngestedAt.toISOString() });
  return { ...acknowledgement, publishAfterAck: {
    topic: mqttTopics.automationExecutionIngested(scope.siteId, scope.gatewayId), payload: acknowledgement
  } };
}

function unavailable() {
  return new ServiceUnavailableException({ code: "manual_execution_replay_unavailable" });
}
