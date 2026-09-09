import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { FIXTURE_IDENTIFY_TTL_MS, fixtureIdentifyCommandSchema, fixtureIdentifyRequestSchema, fixtureIdentifyResultSchema,
  fixtureIdentifyTopics, gatewayHeartbeatFreshSince, type FixtureIdentifyCommand, type FixtureIdentifyResponse, type FixtureIdentifyResult } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";
import { MqttService } from "../mqtt/mqtt.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { identifyCoordinationDeadline as bounded } from "./fixture-identify-deadline";

export const identifyCompareDelete = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const prefix = "fixture-identify:v1";
const key = (kind: string, id: string) => `${prefix}:${kind}:${id}`;
type LeaseRow = { id: string; siteId: string; editorLeaseHolderId: string | null; editorLeaseTokenHash: string | null;
  editorLeaseFence: number; editorLeaseExpiresAt: Date | null };

@Injectable()
export class FixtureIdentifyService implements OnModuleInit, OnModuleDestroy {
  private removeListener?: () => void;
  private stopping = false;
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly audit: AuditService, private readonly redis: RedisProvider, private readonly mqtt: MqttService) {}

  onModuleInit() { this.removeListener = this.mqtt.onFixtureIdentifyResult((result) => this.receiveResult(result)); }
  onModuleDestroy() { this.stopping = true; this.removeListener?.(); }

  async identify(floorId: string, fixtureId: string, user: AuthenticatedUser, input: unknown): Promise<FixtureIdentifyResponse> {
    const parsed = fixtureIdentifyRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("invalid_fixture_identify_request");
    const request = parsed.data;
    const commandId = randomUUID();
    const sessionId = request.sessionId ?? randomUUID();
    const prepared = await this.prisma.$transaction(async (tx) => {
      const floorRef = await tx.floor.findUnique({ where: { id: floorId }, select: { siteId: true } });
      if (!floorRef) throw new NotFoundException("floor not found");
      const site = await this.access.assertManageInTransaction(tx, user, floorRef.siteId);
      const [floor] = await tx.$queryRaw<LeaseRow[]>(Prisma.sql`SELECT "id", "siteId", "editorLeaseHolderId", "editorLeaseTokenHash", "editorLeaseFence", "editorLeaseExpiresAt" FROM "Floor" WHERE "id" = ${floorId} FOR UPDATE`);
      const [clock] = await tx.$queryRaw<Array<{ dbNow: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "dbNow"`);
      const now = clock!.dbNow;
      if (!floor || floor.siteId !== site.id || floor.editorLeaseHolderId !== user.id || floor.editorLeaseFence !== request.leaseFence ||
        floor.editorLeaseTokenHash !== hashEditorLeaseToken(request.leaseToken) || !floor.editorLeaseExpiresAt || floor.editorLeaseExpiresAt <= now) {
        throw new ForbiddenException("floor editor lease is invalid or expired");
      }
      // A start cannot outlive its issuing lease. Require renewal instead of silently
      // changing the fixed ten-second deadline or allowing a stale editor to blink.
      if (request.action === "start" && floor.editorLeaseExpiresAt.getTime() < now.getTime() + FIXTURE_IDENTIFY_TTL_MS) {
        throw new ConflictException("floor editor lease requires renewal");
      }
      const fixture = await tx.fixture.findFirst({ where: { id: fixtureId, floorId, siteId: site.id }, include: {
        meshNode: { include: { gateway: { include: {
          inventory: true,
          certificates: { where: { purpose: "mqtt", status: "active", revokedAt: null, notBefore: { lte: now }, notAfter: { gt: now } } }
        } } } }
      } });
      if (!fixture) throw new NotFoundException("fixture not found");
      const gateway = fixture.meshNode?.gateway;
      if (!gateway || !fixture.gatewayId || gateway.id !== fixture.gatewayId || gateway.siteId !== site.id ||
        !gateway.claimedAt || !gateway.inventory?.claimedAt || gateway.inventory.disabledAt || gateway.inventory.claimedGatewayId !== gateway.id ||
        !gateway.certificates.some((certificate) => certificate.inventoryId === gateway.inventory!.id) ||
        fixture.statusReason === "provisioning_waiting_state") throw new ConflictException("fixture_not_registered");
      if (!gateway.lastHeartbeatAt || gateway.lastHeartbeatAt < gatewayHeartbeatFreshSince(now)) throw new ConflictException("gateway_offline");
      if (fixture.status === "offline" || !fixture.lastSeenAt || fixture.lastSeenAt.getTime() < now.getTime() - 180_000) throw new ConflictException("fixture_offline");
      const command = fixtureIdentifyCommandSchema.parse({ version: 1, commandId, sessionId, fixtureId, siteId: site.id,
        gatewayId: gateway.id, action: request.action, requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + FIXTURE_IDENTIFY_TTL_MS).toISOString() });
      const activeKey = key("active", gateway.id);
      const client = this.redis.getClient();
      const operationKey = key("operation", gateway.id);
      if (!await bounded(client.set(operationKey, commandId, "PX", 10_000, "NX"))) throw new ConflictException("gateway_busy");
      try {
        if (command.action === "start") {
          if (!await bounded(client.set(key("session", sessionId), commandId, "PX", 30_000, "NX"))) throw new ConflictException("duplicate_session");
          if (!await bounded(client.set(activeKey, JSON.stringify({ sessionId, fixtureId }), "PX", FIXTURE_IDENTIFY_TTL_MS + 2000, "NX"))) throw new ConflictException("gateway_busy");
        } else {
          const active = await bounded(client.get(activeKey));
          if (active !== JSON.stringify({ sessionId, fixtureId })) throw new ConflictException("stale_session");
        }
        await bounded(client.set(key("command", commandId), JSON.stringify(command), "PX", 30_000));
        await this.audit.record({ organizationId: site.organizationId, siteId: site.id, actorId: user.id,
          action: `fixture.identify.${command.action}`, targetType: "fixture", targetId: fixtureId, outcome: "requested",
          metadata: { commandId, sessionId, floorId, expiresAt: command.expiresAt }, transaction: tx });
        return { command, organizationId: site.organizationId };
      } catch (error) {
        await bounded(client.eval(identifyCompareDelete, 1, operationKey, commandId));
        throw error;
      }
    });
    const { command } = prepared;
    let response: FixtureIdentifyResponse;
    try {
      response = await this.dispatchAndWait(command);
      if (response.status === "stopped") {
        await bounded(this.redis.getClient().eval(identifyCompareDelete, 1, key("active", command.gatewayId), JSON.stringify({ sessionId, fixtureId })));
      }
      await this.audit.record({ organizationId: prepared.organizationId, siteId: command.siteId, actorId: user.id,
        action: `fixture.identify.${command.action}.result`, targetType: "fixture", targetId: fixtureId, outcome: response.status,
        metadata: { commandId, sessionId, dispatchStatus: response.dispatchStatus, ...(response.reason ? { reason: response.reason } : {}) } });
      return response;
    } finally {
      await bounded(this.redis.getClient().eval(identifyCompareDelete, 1, key("operation", command.gatewayId), commandId));
    }
  }

  async receiveResult(input: FixtureIdentifyResult) {
    const result = fixtureIdentifyResultSchema.parse(input);
    const client = this.redis.getClient();
    const raw = await bounded(client.get(key("command", result.commandId)));
    if (!raw) return;
    const command = fixtureIdentifyCommandSchema.parse(JSON.parse(raw));
    if (Object.keys(command).some((field) => command[field as keyof FixtureIdentifyCommand] !== result[field as keyof FixtureIdentifyCommand])) return;
    const reported = Date.parse(result.reportedAt);
    if (reported < Date.parse(command.requestedAt) || reported > Date.now() + 1000) return;
    if ((result.status === "attention_confirmed" || result.status === "stopped") &&
      (reported >= Date.parse(command.expiresAt) || Date.now() >= Date.parse(command.expiresAt))) return;
    // Shared Redis bridges HTTP and MQTT workers without opening another MQTT
    // connection; first exact terminal wins and late/replayed outcomes cannot overwrite it.
    await bounded(client.set(key("result", result.commandId), JSON.stringify(result), "PX", 30_000, "NX"));
  }

  private async dispatchAndWait(command: FixtureIdentifyCommand): Promise<FixtureIdentifyResponse> {
    const base = { commandId: command.commandId, sessionId: command.sessionId, fixtureId: command.fixtureId,
      action: command.action, expiresAt: command.expiresAt };
    let dispatchStatus: FixtureIdentifyResponse["dispatchStatus"] = "unconfirmed";
    try {
      if (Date.now() >= Date.parse(command.expiresAt) || this.stopping) return { ...base, dispatchStatus, status: "rejected", reason: "command_expired" };
      await this.mqtt.publishTopic(fixtureIdentifyTopics.command(command.siteId, command.gatewayId), command, { timeoutMs: 1000, messageExpiryInterval: 10 });
      dispatchStatus = "broker_accepted";
    } catch {
      // A failed PUBACK wait is uncertain, so retain the gateway reservation until
      // TTL. A packet already handed to the broker may still reach the node.
      return { ...base, dispatchStatus, status: "dispatch_failed", reason: "broker_dispatch_unconfirmed" };
    }
    const deadline = Math.min(Date.now() + 3000, Date.parse(command.expiresAt));
    while (!this.stopping && Date.now() < deadline) {
      const raw = await bounded(this.redis.getClient().get(key("result", command.commandId)));
      if (raw) {
        const result = fixtureIdentifyResultSchema.parse(JSON.parse(raw));
        return { ...base, dispatchStatus, status: result.status, ...(result.reason ? { reason: result.reason } : {}) };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ...base, dispatchStatus, status: "timed_out", reason: "attention_result_timeout" };
  }
}
