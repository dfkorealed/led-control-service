import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
  PayloadTooLargeException
} from "@nestjs/common";
import { MonitoringRefresh, Prisma } from "@prisma/client";
import { fixturePresenceCheckCommandV1Schema, mqttTopicsV2 } from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { MonitoringRefreshInput } from "./monitoring-refresh.dto";

const REFRESH_DEADLINE_MS = 30_000;
const TERMINAL_COOLDOWN_MS = 30_000;
const MAX_FIXTURES = 1_000;
const MAX_BATCH_FIXTURES = 64;
const TERMINAL_STATUSES = ["completed", "partial", "failed", "expired"] as const;

type ServiceOptions = { clock?: () => Date; uuid?: () => string };
type FixtureTarget = { id: string; meshNode: { gatewayId: string } | null };

@Injectable()
export class MonitoringRefreshService {
  private readonly clock: () => Date;
  private readonly uuid: () => string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService,
    @Optional() options: ServiceOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
  }

  async create(
    user: AuthenticatedUser,
    siteId: string,
    floorId: string,
    input: MonitoringRefreshInput
  ) {
    await this.siteAccess.assert(user, siteId, "read");

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.siteAccess.assertReadInTransaction(tx, user, siteId);
        // Serialize active-request reuse and cooldown decisions per floor. Without
        // this lock, two different client request IDs could both observe no active job.
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "Floor" WHERE "id" = ${floorId} AND "siteId" = ${siteId} FOR UPDATE
        `);
        const floor = await tx.floor.findFirst({ where: { id: floorId, siteId, status: "active" } });
        if (!floor) throw new NotFoundException("floor not found");

        const request = await tx.monitoringRefreshRequest.findUnique({
          where: {
            siteId_requestedById_clientRequestId: {
              siteId,
              requestedById: user.id,
              clientRequestId: input.clientRequestId
            }
          },
          include: { refresh: true }
        });
        if (request) {
          if (request.floorId !== floorId) {
            throw new ConflictException({ code: "monitoring_refresh_payload_conflict" });
          }
          return createProjection(request.refresh);
        }

        // Compatibility for refreshes created before request aliases existed.
        const legacy = await tx.monitoringRefresh.findUnique({
          where: {
            siteId_requestedById_clientRequestId: {
              siteId,
              requestedById: user.id,
              clientRequestId: input.clientRequestId
            }
          }
        });
        if (legacy) {
          if (legacy.floorId !== floorId) {
            throw new ConflictException({ code: "monitoring_refresh_payload_conflict" });
          }
          await createRequestAlias(tx, user.id, input.clientRequestId, legacy);
          return createProjection(legacy);
        }

        const active = await tx.monitoringRefresh.findFirst({
          where: { siteId, floorId, status: "pending" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }]
        });
        if (active) {
          await createRequestAlias(tx, user.id, input.clientRequestId, active);
          return createProjection(active);
        }

        const now = this.clock();
        const latestRequest = await tx.monitoringRefreshRequest.findFirst({
          where: {
            siteId,
            floorId,
            requestedById: user.id,
            refresh: {
              status: { in: [...TERMINAL_STATUSES] },
              completedAt: { gt: new Date(now.getTime() - TERMINAL_COOLDOWN_MS) }
            }
          },
          orderBy: { refresh: { completedAt: "desc" } },
          select: { refresh: { select: { completedAt: true } } }
        });
        const latestTerminal = latestRequest?.refresh ?? await tx.monitoringRefresh.findFirst({
          where: {
            siteId,
            floorId,
            requestedById: user.id,
            status: { in: [...TERMINAL_STATUSES] },
            completedAt: { gt: new Date(now.getTime() - TERMINAL_COOLDOWN_MS) }
          },
          orderBy: [{ completedAt: "desc" }, { id: "desc" }],
          select: { completedAt: true }
        });
        if (latestTerminal?.completedAt) {
          throw new HttpException({
            code: "monitoring_refresh_cooldown",
            retryAt: new Date(latestTerminal.completedAt.getTime() + TERMINAL_COOLDOWN_MS).toISOString()
          }, HttpStatus.TOO_MANY_REQUESTS);
        }

        const selectedFixtures = await tx.fixture.findMany({
          where: { floorId, siteId, meshNode: { isNot: null } },
          select: { id: true, meshNode: { select: { gatewayId: true } } },
          orderBy: { id: "asc" },
          take: MAX_FIXTURES + 1
        });
        if (selectedFixtures.length > MAX_FIXTURES) {
          throw new PayloadTooLargeException({ code: "monitoring_refresh_fixture_limit_exceeded" });
        }

        const refreshId = this.uuid();
        const deadlineAt = new Date(now.getTime() + REFRESH_DEADLINE_MS);
        const noTargets = selectedFixtures.length === 0;
        const refresh = await tx.monitoringRefresh.create({
          data: {
            id: refreshId,
            siteId,
            floorId,
            requestedById: user.id,
            clientRequestId: input.clientRequestId,
            status: noTargets ? "completed" : "pending",
            totalFixtures: selectedFixtures.length,
            deadlineAt,
            completedAt: noTargets ? now : null,
            createdAt: now
          }
        });
        await createRequestAlias(tx, user.id, input.clientRequestId, refresh);
        if (noTargets) return createProjection(refresh);

        await this.createSnapshot(tx, refreshId, siteId, now, deadlineAt, selectedFixtures as FixtureTarget[]);
        return createProjection(refresh);
      });
    } catch (error) {
      if (!isIdempotencyCollision(error)) throw error;
      const winnerRequest = await this.prisma.monitoringRefreshRequest.findUnique({
        where: {
          siteId_requestedById_clientRequestId: {
            siteId,
            requestedById: user.id,
            clientRequestId: input.clientRequestId
          }
        },
        include: { refresh: true }
      });
      const winner = winnerRequest?.refresh ?? await this.prisma.monitoringRefresh.findUnique({
        where: {
          siteId_requestedById_clientRequestId: {
            siteId,
            requestedById: user.id,
            clientRequestId: input.clientRequestId
          }
        }
      });
      if (!winner) throw error;
      if ((winnerRequest?.floorId ?? winner.floorId) !== floorId) {
        throw new ConflictException({ code: "monitoring_refresh_payload_conflict" });
      }
      return createProjection(winner);
    }
  }

  async get(user: AuthenticatedUser, siteId: string, refreshId: string) {
    await this.siteAccess.assert(user, siteId, "read");
    const refresh = await this.prisma.monitoringRefresh.findFirst({ where: { id: refreshId, siteId } });
    if (!refresh) throw new NotFoundException("monitoring refresh not found");
    return getProjection(refresh);
  }

  private async createSnapshot(
    tx: Prisma.TransactionClient,
    refreshId: string,
    siteId: string,
    requestedAt: Date,
    deadlineAt: Date,
    fixtures: FixtureTarget[]
  ) {
    const byGateway = new Map<string, string[]>();
    for (const fixture of fixtures) {
      if (!fixture.meshNode) continue;
      const ids = byGateway.get(fixture.meshNode.gatewayId) ?? [];
      ids.push(fixture.id);
      byGateway.set(fixture.meshNode.gatewayId, ids);
    }

    for (const [gatewayId, fixtureIds] of [...byGateway.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      fixtureIds.sort();
      for (let offset = 0; offset < fixtureIds.length; offset += MAX_BATCH_FIXTURES) {
        const targetFixtureIds = fixtureIds.slice(offset, offset + MAX_BATCH_FIXTURES);
        const gateway = await tx.gateway.update({
          where: { id: gatewayId },
          data: { nextCommandSequence: { increment: 1 } },
          select: { id: true, siteId: true, nextCommandSequence: true }
        });
        if (gateway.siteId !== siteId) throw new Error("monitoring refresh gateway site mismatch");
        const sequence = Number(gateway.nextCommandSequence);
        if (!Number.isSafeInteger(sequence)) {
          throw new Error("gateway command sequence exceeded safe integer range");
        }

        const batchId = this.uuid();
        const idempotencyKey = this.uuid();
        const payload = fixturePresenceCheckCommandV1Schema.parse({
          refreshId,
          batchId,
          idempotencyKey,
          sequence,
          siteId,
          gatewayId,
          targetFixtureIds,
          requestedAt: requestedAt.toISOString(),
          expiresAt: deadlineAt.toISOString()
        });
        await tx.monitoringRefreshBatch.create({
          data: {
            id: batchId,
            refreshId,
            siteId,
            gatewayId,
            sequence: BigInt(sequence),
            idempotencyKey,
            targetFixtureIds
          }
        });
        await tx.monitoringRefreshFixture.createMany({
          data: targetFixtureIds.map((fixtureId) => ({ refreshId, siteId, fixtureId, batchId }))
        });
        await tx.mqttOutbox.create({
          data: {
            monitoringRefreshBatchId: batchId,
            topic: mqttTopicsV2.fixturePresenceCheck(siteId, gatewayId),
            payload
          }
        });
      }
    }
  }
}

function createRequestAlias(
  tx: Prisma.TransactionClient,
  requestedById: string,
  clientRequestId: string,
  refresh: Pick<MonitoringRefresh, "id" | "siteId" | "floorId">
) {
  return tx.monitoringRefreshRequest.create({
    data: {
      siteId: refresh.siteId,
      floorId: refresh.floorId,
      requestedById,
      clientRequestId,
      refreshId: refresh.id
    }
  });
}

function isIdempotencyCollision(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "P2002") return false;
  const target = "meta" in error && typeof error.meta === "object" && error.meta !== null && "target" in error.meta
    ? error.meta.target
    : undefined;
  const fields = Array.isArray(target)
    ? target.filter((field): field is string => typeof field === "string")
    : typeof target === "string" ? [target] : [];
  return fields.some((field) => field === "MonitoringRefreshRequest_pkey"
    || field === "MonitoringRefresh_siteId_requestedById_clientRequestId_key"
    || field.includes("siteId") && field.includes("requestedById") && field.includes("clientRequestId"))
    || ["siteId", "requestedById", "clientRequestId"].every((field) => fields.includes(field));
}

function createProjection(refresh: Pick<MonitoringRefresh, "id" | "siteId" | "status" | "totalFixtures">) {
  return {
    id: refresh.id,
    status: refresh.status,
    totalFixtures: refresh.totalFixtures,
    terminalStatusUrl: `/sites/${refresh.siteId}/monitoring-refreshes/${refresh.id}`
  };
}

function getProjection(refresh: Pick<MonitoringRefresh,
  "id" | "status" | "totalFixtures" | "onlineFixtures" | "offlineFixtures" | "unverifiedFixtures" | "completedAt"
>) {
  return {
    id: refresh.id,
    status: refresh.status,
    totalFixtures: refresh.totalFixtures,
    onlineFixtures: refresh.onlineFixtures,
    offlineFixtures: refresh.offlineFixtures,
    unverifiedFixtures: refresh.unverifiedFixtures,
    completedAt: refresh.completedAt?.toISOString() ?? null
  };
}
