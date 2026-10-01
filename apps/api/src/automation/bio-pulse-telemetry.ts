import { BadRequestException } from "@nestjs/common";
import { automationSnapshotSchema, bioPulseExecutionIngestedAckV2Schema, mqttTopics, type BioPulseExecutionEventV2 } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { canonicalPayloadHash } from "./automation-payload-hash";

type Scope = { siteId: string; gatewayId: string };
type Event = BioPulseExecutionEventV2;
const sourceBindingsSchema = z.record(z.string().uuid(), z.string().uuid().nullable());

/** Membership lock precedes identity locks, matching config/assignment mutations.
 * Broker mTLS/topic ACL authenticates delivery; the SQL checks current authority,
 * not the peer certificate (which MQTT subscribers do not receive). */
export async function ingestBioPulseTelemetry(tx: Prisma.TransactionClient, scope: Scope, event: Event, now: Date) {
  await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
  const identities = await tx.$queryRaw<Array<{ assignmentVersion: number }>>(Prisma.sql`
    SELECT gateway."assignmentVersion" FROM "Gateway" gateway
    JOIN "GatewayInventory" inventory ON inventory."claimedGatewayId"=gateway.id
      AND inventory."claimedAt" IS NOT NULL AND inventory."disabledAt" IS NULL
    JOIN "GatewayCertificate" certificate ON certificate."gatewayId"=gateway.id
      AND certificate."inventoryId"=inventory.id AND certificate.purpose='mqtt'
      AND certificate.status='active' AND certificate."revokedAt" IS NULL
      AND certificate."notBefore" <= ${now} AND certificate."notAfter" > ${now}
    WHERE gateway.id=${scope.gatewayId} AND gateway."siteId"=${scope.siteId}
    FOR UPDATE OF gateway, inventory, certificate
  `);
  if (!identities.length) return;
  const hash = canonicalBioPulseTelemetryHash(event);
  const existing = await tx.bioPulseTelemetryEvent.findFirst({ where: { gatewayId: scope.gatewayId,
    OR: [{ eventId: event.eventId }, { assignmentVersion: event.assignmentVersion, sequence: BigInt(event.sequence) }] } });
  if (existing) {
    if (existing.siteId !== scope.siteId || existing.eventId !== event.eventId || existing.assignmentVersion !== event.assignmentVersion ||
      existing.sequence !== BigInt(event.sequence) || existing.payloadHash !== hash) {
      throw new BadRequestException("BIO telemetry identity conflict");
    }
    return persistAck(tx, scope, event, hash, existing.receivedAt, now);
  }
  // An exact committed receipt may drain after same-site assignment rotation,
  // but new evidence must still prove the current assignment and declaration.
  if (identities[0]!.assignmentVersion !== event.assignmentVersion) return;
  const declaration = await tx.gatewayAutomationProtocolSupport.findFirst({
    where: { ...scope, assignmentVersion: event.assignmentVersion }, orderBy: { declarationRevision: "desc" }
  });
  if (declaration?.maxSnapshotVersion !== 2) return;
  const rows = await tx.mqttOutbox.findMany({ where: { gatewayId: scope.gatewayId, revision: event.revision,
    dispatchId: null, applicationAckKey: null, automationAssignmentVersion: event.assignmentVersion } });
  if (rows.length !== 1) return;
  const row = rows[0]!;
  const parsed = automationSnapshotSchema.safeParse(row.payload);
  if (!parsed.success || parsed.data.schemaVersion !== 2 || row.topic !== mqttTopics.automationConfig(scope.siteId, scope.gatewayId)) return;
  const { payloadHash, ...body } = parsed.data;
  if (body.siteId !== scope.siteId || body.gatewayId !== scope.gatewayId || body.revision !== event.revision ||
    row.payloadHash !== payloadHash || canonicalPayloadHash(body) !== payloadHash) return;
  const rule = body.vehicleEventRules.find(rule => rule.id === event.ruleId && rule.status === "enabled" && rule.sensorProtocol === "bio-usb-pulse");
  if (!rule || rule.sourceFixtureIds.length !== 1 || rule.targetFixtureIds.includes(rule.sourceFixtureIds[0]!)) return;
  const sourceFixtureId = rule.sourceFixtureIds[0]!;
  const bindings = sourceBindingsSchema.safeParse(row.automationSourceBindings);
  const expectedSources = [...new Set(body.vehicleEventRules.filter(rule => rule.sensorProtocol === "bio-usb-pulse")
    .flatMap(rule => rule.sourceFixtureIds))].sort();
  if (!bindings.success || canonicalPayloadHash(Object.keys(bindings.data).sort()) !== canonicalPayloadHash(expectedSources)) return;
  const sourceMeshNodeId = bindings.data[sourceFixtureId];
  if (!sourceMeshNodeId) return;
  const targets = [...rule.targetFixtureIds].sort();
  const payload = event.payload;
  if (payload.sourceFixtureId !== undefined && payload.sourceFixtureId !== sourceFixtureId) return;
  if (Array.isArray(payload.targetFixtureIds) && !sameIds(payload.targetFixtureIds, targets)) return;
  for (const key of ["results", "previousRestores"]) {
    if (Array.isArray(payload[key]) && (payload[key] as Array<{ fixtureId: string }>).some(result => !targets.includes(result.fixtureId))) return;
  }
  if (typeof payload.brightnessPercent === "number" && payload.brightnessPercent !== rule.action.brightnessPercent) return;
  const configuration = await tx.gatewayAutomationConfiguration.findUnique({ where: { gatewayId: scope.gatewayId } });
  if (!configuration || event.revision > configuration.desiredRevision) return;
  const latest = await tx.bioPulseTelemetryEvent.findFirst({ where: { gatewayId: scope.gatewayId, assignmentVersion: event.assignmentVersion }, orderBy: { sequence: "desc" } });
  // Authentic but clock-invalid records must drain the shared FIFO. Quarantine
  // them only after snapshot/source/target attribution, never as live evidence.
  const untrustedTime = Date.parse(event.occurredAt) > now.getTime() || Date.parse(event.occurredAt) < Date.parse(body.generatedAt);
  const currentSource = await tx.fixture.findFirst({ where: { id: sourceFixtureId, ...scope }, select: { meshNodeId: true } });
  const staleSource = currentSource?.meshNodeId !== sourceMeshNodeId;
  const disposition = untrustedTime ? "untrusted_time" : event.revision !== configuration.desiredRevision || staleSource ? "stale_configuration"
    : latest && latest.sequence > BigInt(event.sequence) ? "stale_sequence" : "accepted";
  if (disposition === "accepted") {
    const fixtures = await tx.fixture.findMany({ where: { id: { in: [sourceFixtureId, ...targets] }, ...scope, meshNodeId: { not: null } }, include: { meshNode: true } });
    if (fixtures.length !== targets.length + 1 || fixtures.find(f => f.id === sourceFixtureId)?.meshNode?.vehicleSensorProtocol !== "bio_usb_pulse") return;
  }
  const saved = await tx.bioPulseTelemetryEvent.create({ data: {
    ...scope, assignmentVersion: event.assignmentVersion, eventId: event.eventId, sequence: BigInt(event.sequence),
    revision: event.revision, ruleId: event.ruleId, occurrenceKey: event.occurrenceKey, sourceFixtureId,
    targetFixtureIds: targets, kind: event.kind, occurredAt: new Date(event.occurredAt),
    payload: payload as Prisma.InputJsonValue, payloadHash: hash, disposition, receivedAt: now
  } });
  if (disposition === "accepted") await projectEvent(tx, scope, event, sourceFixtureId, sourceMeshNodeId, targets, now);
  return persistAck(tx, scope, event, hash, saved.receivedAt, now);
}

async function projectEvent(tx: Prisma.TransactionClient, scope: Scope, event: Event, sourceFixtureId: string, sourceMeshNodeId: string, targetFixtureIds: string[], now: Date) {
  const identity = { gatewayId: scope.gatewayId, assignmentVersion: event.assignmentVersion, ruleId: event.ruleId, occurrenceKey: event.occurrenceKey };
  const where = { gatewayId_assignmentVersion_ruleId_occurrenceKey: identity };
  const previous = await tx.bioPulseTelemetryProjection.findUnique({ where });
  // Never merge one physical source's occurrence into a replacement source.
  // Its historical event is durable, but that occurrence cannot qualify a view.
  if (previous && previous.sourceMeshNodeId !== sourceMeshNodeId) return;
  const at = new Date(event.occurredAt);
  const payload = event.payload;
  const changes: Partial<Pick<Prisma.BioPulseTelemetryProjectionUncheckedCreateInput,
    "lastPulseAt" | "lastPulseSequence" | "health" | "healthReason" | "degradedSince" | "restorationPending" | "restorationReason" | "configurationReadback">> = {};
  if (payload.inputType === "pulse") { changes.lastPulseAt = at; changes.lastPulseSequence = BigInt(event.sequence); }
  if (payload.reason === "bio_source_degraded") {
    changes.health = String(payload.health); changes.healthReason = String(payload.healthReason);
    changes.degradedSince = previous?.degradedSince ?? at;
    changes.restorationPending = true; changes.restorationReason = String(payload.healthReason);
  } else if (payload.reason === "bio_health_recovered") {
    changes.health = "healthy"; changes.healthReason = "qualified"; changes.degradedSince = null;
    // Recovery restarts observation; it is not successful restoration.
  }
  if (typeof payload.restorationPending === "boolean") {
    changes.restorationPending = payload.restorationPending;
    changes.restorationReason = payload.restorationPending ? String(payload.releaseReason ?? payload.healthReason ?? payload.reason) : null;
  }
  if (event.kind === "action_result") {
    changes.configurationReadback = { ...payload, occurredAt: event.occurredAt, sequence: event.sequence } as Prisma.InputJsonValue;
  }
  const base = { ...scope, ...identity, revision: event.revision, sourceFixtureId, sourceMeshNodeId, targetFixtureIds,
    sequence: BigInt(event.sequence), lastEventAt: at, receivedAt: now };
  await tx.bioPulseTelemetryProjection.upsert({ where, create: { ...base, ...changes },
    update: { ...base, ...changes } });
}

async function persistAck(tx: Prisma.TransactionClient, scope: Scope, event: Event, hash: string, ingestedAt: Date, now: Date) {
  const ack = bioPulseExecutionIngestedAckV2Schema.parse({ schemaVersion: 2, assignmentVersion: event.assignmentVersion,
    gatewayId: scope.gatewayId, eventId: event.eventId, sequence: event.sequence, reportPayloadHash: hash, ingestedAt: ingestedAt.toISOString() });
  const applicationAckKey = `bio-pulse:${scope.gatewayId}:${event.assignmentVersion}:${event.eventId}:${event.sequence}:${hash}`;
  const existing = await tx.mqttOutbox.findUnique({ where: { applicationAckKey } });
  if (!existing) {
    await tx.mqttOutbox.create({ data: { gatewayId: scope.gatewayId, applicationAckKey, payloadHash: canonicalPayloadHash(ack),
      topic: mqttTopics.automationExecutionIngested(scope.siteId, scope.gatewayId), payload: ack } });
  } else {
    if (canonicalPayloadHash(existing.payload) !== canonicalPayloadHash(ack)) throw new BadRequestException("BIO ACK identity conflict");
    await tx.mqttOutbox.updateMany({ where: { id: existing.id, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      data: { publishedAt: null, deadLetteredAt: null, attempts: 0, nextAttemptAt: now, lockedBy: null, lockedAt: null, leaseExpiresAt: null, lastError: null } });
  }
  // No network operation here: the ordinary outbox publisher sees this row only
  // after the caller's transaction commits its ledger and projection together.
  return ack;
}

export function canonicalBioPulseTelemetryHash(event: Event) {
  if (event.kind !== "action_result") return canonicalPayloadHash(event);
  return canonicalPayloadHash({ ...event, payload: { ...event.payload,
    results: [...event.payload.results as Array<{ fixtureId: string }>].sort((a, b) => a.fixtureId < b.fixtureId ? -1 : a.fixtureId > b.fixtureId ? 1 : 0) } });
}

function sameIds(ids: unknown[], expected: string[]) {
  return ids.length === expected.length && [...ids].sort().every((id, index) => id === expected[index]);
}
