import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { bioSensorModeCommandSchema, bioSensorModeRequestSchema, bioSensorModeResultSchema, bioSensorModeTopics,
  type BioSensorModeRequest } from "@led-control/shared";
import { Prisma, type SensorModeOperation } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { lockAutomationProtocolIdentity } from "../automation/automation-protocol-support";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { parseGatewayTopic } from "../mqtt/topic-scope";

@Injectable()
export class SensorModeOperationsService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly snapshots: AutomationSnapshotService) {}

  async create(user: AuthenticatedUser, value: BioSensorModeRequest) {
    const input = bioSensorModeRequestSchema.parse(value);
    await this.access.assert(user, input.siteId, "control");
    return this.prisma.$transaction(async (tx) => {
      await this.snapshots.lockMutation(tx);
      await this.access.assertControlInTransaction(tx, user, input.siteId);
      const existing = await tx.sensorModeOperation.findUnique({ where: {
        siteId_requestedById_clientRequestId: { siteId: input.siteId, requestedById: user.id, clientRequestId: input.clientRequestId }
      } });
      if (existing) {
        if (existing.fixtureId !== input.fixtureId || existing.operation !== input.operation ||
            existing.requeryOfCommandId !== (input.requeryOfCommandId ?? null)) throw new ConflictException("sensor mode request identity conflict");
        return view(existing);
      }
      const fixture = await tx.fixture.findFirst({ where: { id: input.fixtureId, siteId: input.siteId }, include: { meshNode: true } });
      const node = fixture?.meshNode;
      if (!fixture || !node || node.vehicleSensorProtocol !== "bio_usb_pulse" || !node.deviceUuid?.startsWith("bio:")) {
        throw new BadRequestException("confirmed BIO fixture required");
      }
      const scope = { siteId: input.siteId, gatewayId: node.gatewayId };
      const identity = await lockAutomationProtocolIdentity(tx, scope);
      if (!identity) throw new ConflictException("current claimed gateway required");
      await lockFixture(tx, fixture.id);
      const current = await tx.fixture.findUnique({ where: { id: fixture.id }, include: { meshNode: true } });
      if (current?.meshNodeId !== node.id || current.gatewayId !== node.gatewayId || current.meshNode?.vehicleSensorProtocol !== "bio_usb_pulse") {
        throw new ConflictException("BIO fixture mapping changed");
      }
      if (input.requeryOfCommandId) {
        const previous = await tx.sensorModeOperation.findUnique({ where: { commandId: input.requeryOfCommandId } });
        if (!previous || previous.siteId !== input.siteId || previous.fixtureId !== fixture.id || previous.gatewayId !== node.gatewayId) {
          throw new BadRequestException("sensor mode requery scope mismatch");
        }
      }
      const now = new Date();
      const payload = bioSensorModeCommandSchema.parse({ version: 2, commandId: randomUUID(), ...scope,
        deviceIdentityHash: sensorModeDeviceIdentityHash(node.deviceUuid),
        fixtureId: fixture.id, nodeId: node.id, meshAddress: normalizeAddress(node.meshAddress), assignmentVersion: identity.assignmentVersion,
        operation: input.operation, ...(input.requeryOfCommandId ? { requeryOfCommandId: input.requeryOfCommandId } : {}),
        requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString() });
      // A new request never inherits an old result, including a previous successful GET.
      await tx.sensorModeOperation.updateMany({ where: { fixtureId: fixture.id, supersededAt: null }, data: { supersededAt: now } });
      const created = await tx.sensorModeOperation.create({ data: {
        commandId: payload.commandId, ...scope, fixtureId: fixture.id, nodeId: node.id, meshAddress: payload.meshAddress,
        assignmentVersion: identity.assignmentVersion, requestedById: user.id, clientRequestId: input.clientRequestId,
        operation: input.operation, requeryOfCommandId: input.requeryOfCommandId, requestedAt: now, expiresAt: new Date(payload.expiresAt), payload
      } });
      return view(created);
    });
  }

  async get(user: AuthenticatedUser, commandId: string) {
    const row = await this.prisma.sensorModeOperation.findUnique({ where: { commandId } });
    if (!row) throw new NotFoundException("sensor mode operation not found");
    await this.access.assert(user, row.siteId, "read");
    await this.expire();
    return view(await this.prisma.sensorModeOperation.findUniqueOrThrow({ where: { commandId } }));
  }

  async expire(now = new Date()) {
    return this.prisma.sensorModeOperation.updateMany({ where: { status: "pending", expiresAt: { lte: now } },
      data: { status: "timed_out", lockedBy: null, leaseExpiresAt: null } });
  }

  async ingest(topic: string, value: unknown, receivedAt = new Date()) {
    const result = bioSensorModeResultSchema.parse(value);
    const scope = parseGatewayTopic(topic);
    if (!scope || topic !== bioSensorModeTopics.result(result.siteId, result.gatewayId)) throw new BadRequestException("sensor mode result scope mismatch");
    const hash = canonicalPayloadHash(result);
    return this.prisma.$transaction(async (tx) => {
      await this.snapshots.lockMutation(tx);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Site" WHERE "id" = ${result.siteId} FOR KEY SHARE`);
      const identity = await lockAutomationProtocolIdentity(tx, result);
      if (!identity) throw new BadRequestException("sensor mode assignment unverified");
      await lockFixture(tx, result.fixtureId);
      const fixture = await tx.fixture.findFirst({ where: { id: result.fixtureId, siteId: result.siteId, gatewayId: result.gatewayId }, include: { meshNode: true } });
      const currentIdentity = identity.assignmentVersion === result.assignmentVersion && fixture?.meshNodeId === result.nodeId &&
        fixture.meshNode?.deviceUuid !== null && fixture.meshNode?.deviceUuid !== undefined &&
        sensorModeDeviceIdentityHash(fixture.meshNode.deviceUuid) === result.deviceIdentityHash &&
        fixture.meshNode?.vehicleSensorProtocol === "bio_usb_pulse" && normalizeAddress(fixture.meshNode.meshAddress) === result.meshAddress;
      await tx.$queryRaw(Prisma.sql`SELECT "commandId" FROM "SensorModeOperation" WHERE "commandId" = ${result.commandId} FOR UPDATE`);
      const row = await tx.sensorModeOperation.findUnique({ where: { commandId: result.commandId } });
      if (!row) throw new BadRequestException("unknown sensor mode operation");
      const command = bioSensorModeCommandSchema.parse(row.payload);
      if (["siteId", "gatewayId", "fixtureId", "nodeId", "assignmentVersion", "meshAddress", "deviceIdentityHash", "operation", "requeryOfCommandId"].some(
        (key) => command[key as keyof typeof command] !== result[key as keyof typeof result])) throw new BadRequestException("sensor mode result identity mismatch");
      const occurredAt = Date.parse(result.occurredAt);
      // An exact-command authenticated non-success is an audit checkpoint, not
      // successful mode proof. Its clock may itself be the failure (including after
      // restart); rejecting it forever blocks the shared result outbox. Preserve
      // all identity/hash checks and require time proof for verified GET only.
      // Preserve the supplied occurredAt verbatim as untrusted audit data for
      // non-success; it never becomes verifiedAt or overrides server expiry.
      if (result.modeVerified && (occurredAt < row.requestedAt.getTime() || occurredAt > receivedAt.getTime() + 1_000 ||
          occurredAt > row.expiresAt.getTime())) throw new BadRequestException("sensor mode result time mismatch");
      const ack = { eventId: result.eventId, sequence: result.sequence, fixtureId: result.fixtureId };
      if (row.resultHash) {
        if (row.resultHash !== hash) throw new BadRequestException("sensor mode result identity conflict");
        return { ...ack, status: "duplicate" as const };
      }
      // Late delivery remains an audit result, never a promotion after timeout or
      // supersession. No Fixture output/energy or MeshNode capability is updated.
      const status = row.status !== "pending" ? row.status : row.supersededAt || !currentIdentity ? "unknown"
        : receivedAt >= row.expiresAt ? "timed_out" : result.status;
      await tx.sensorModeOperation.update({ where: { commandId: row.commandId }, data: {
        status, result: result as Prisma.InputJsonValue, resultHash: hash, resultEventId: result.eventId, lockedBy: null, leaseExpiresAt: null
      } });
      return { ...ack, status: currentIdentity ? "ingested" as const : "stale_checkpoint" as const };
    });
  }
}

export async function lockFixture(tx: Prisma.TransactionClient, fixtureId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Fixture" WHERE "id" = ${fixtureId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT node."id" FROM "MeshNode" node JOIN "Fixture" fixture ON fixture."meshNodeId" = node."id"
    WHERE fixture."id" = ${fixtureId} FOR SHARE OF node`);
}
export function sensorModeDeviceIdentityHash(deviceUuid: string) { return createHash("sha256").update(deviceUuid).digest("hex"); }
function normalizeAddress(value: string) { return `0x${Number.parseInt(value.replace(/^0x/i, ""), 16).toString(16).padStart(4, "0")}`; }
function view(row: SensorModeOperation) {
  const parsed = bioSensorModeResultSchema.safeParse(row.result);
  return { commandId: row.commandId, siteId: row.siteId, fixtureId: row.fixtureId, operation: row.operation,
    requeryOfCommandId: row.requeryOfCommandId, status: row.status, requestedAt: row.requestedAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null,
    modeVerified: row.status === "verified" && row.supersededAt === null && parsed.success && parsed.data.modeVerified,
    observedMode: parsed.success && "observedMode" in parsed.data ? parsed.data.observedMode : null,
    verifiedAt: row.status === "verified" && row.supersededAt === null && parsed.success ? parsed.data.occurredAt : null };
}
