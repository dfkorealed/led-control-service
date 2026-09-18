import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const DAY_MS = 86_400_000;
const SWEEP_DELETE_BUDGET = 21_000;
type DeletedCounts = { gatewayEvents: number; sessions: number; floorMapRevisions: number; monitoringRefreshes: number };

@Injectable()
export class DataRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataRetentionService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<DeletedCounts>;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (this.timer || process.env.NODE_ENV === "test") return;
    this.timer = setInterval(() => {
      if (!this.running) void this.prune().catch(() => { /* The sweep already logged its failed stage. */ });
    }, 60_000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => { /* Shutdown still drains a failed sweep. */ });
  }

  prune(now = new Date()): Promise<DeletedCounts> {
    // Manual calls and timer ticks share the same guard, including error recovery.
    if (this.running) return this.running;
    this.running = this.sweep(now).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async sweep(now: Date): Promise<DeletedCounts> {
    const started = Date.now();
    const deleted: DeletedCounts = { gatewayEvents: 0, sessions: 0, floorMapRevisions: 0, monitoringRefreshes: 0 };
    let stage: keyof DeletedCounts = "gatewayEvents";
    // Prisma binds JS Date as timestamptz; these schema columns store naive UTC.
    // An implicit comparison would shift the cutoff by the DB session timezone.
    const cutoff = (days: number) => Prisma.sql`(${new Date(now.getTime() - days * DAY_MS)}::timestamptz AT TIME ZONE 'UTC')`;
    try {
      // Each DELETE is one atomic, bounded statement. State/watermark readers use
      // the same snapshot as candidate selection; only the raw candidates are
      // locked so ingestion's snapshot -> watermark lock order cannot deadlock.
      // Legacy NULL scope/hash cannot prove exact replay identity. Retain those
      // rows, incomplete scan terminals and unknown event types indefinitely.
      deleted.gatewayEvents = await this.prisma.$executeRaw(Prisma.sql`
        WITH candidates AS (
          SELECT event."eventId" FROM "ProcessedGatewayEvent" event
          JOIN "GatewayEventWatermark" watermark
            ON watermark."gatewayId" = event."gatewayId" AND watermark."eventType" = event."eventType"
            AND watermark."scopeKey" = CASE
              WHEN event."eventType" IN ('fixture_state', 'vehicle_sensor_capability') THEN event."scopeKey"
              ELSE '' END
          WHERE event."scopeKey" IS NOT NULL AND event."payloadHash" ~ '^sha256:[0-9a-f]{64}$'
            AND watermark."lastPayloadHash" IS NOT NULL
            AND watermark."lastSequence" >= event."sequence"
            AND (watermark."lastSequence" > event."sequence" OR (
              watermark."lastEventId" = event."eventId" AND watermark."lastPayloadHash" = event."payloadHash"
              AND watermark."lastOccurredAt" = event."occurredAt"
            ))
            AND (
              (event."eventType" = 'gateway_heartbeat' AND event."createdAt" < ${cutoff(7)}
                AND event."scopeKey" = '' AND EXISTS (
                  SELECT 1 FROM "Gateway" gateway WHERE gateway."id" = event."gatewayId"
                    AND gateway."lastHeartbeatSequence" >= event."sequence"
                    AND gateway."lastHeartbeatEventId" IS NOT NULL
                    AND gateway."lastHeartbeatOccurredAt" >= event."occurredAt"
                    AND (gateway."lastHeartbeatSequence" > event."sequence" OR gateway."lastHeartbeatEventId" = event."eventId")
                ))
              OR (event."eventType" = 'fixture_state' AND event."createdAt" < ${cutoff(30)} AND EXISTS (
                SELECT 1 FROM "Fixture" fixture
                JOIN "FixtureEnergyStateCursor" cursor ON cursor."fixtureId" = fixture."id"
                WHERE fixture."id" = event."scopeKey" AND fixture."id" = event."fixtureId"
                  AND fixture."gatewayId" = event."gatewayId"
                  AND fixture."lastStateSequence" >= event."sequence" AND fixture."lastStateEventId" IS NOT NULL
                  AND fixture."lastStateOccurredAt" >= event."occurredAt"
                  AND (fixture."lastStateSequence" > event."sequence" OR fixture."lastStateEventId" = event."eventId")
                  AND cursor."aggregatedThrough" >= event."occurredAt"
                  AND cursor."observedStateOccurredAt" >= event."occurredAt"
              ))
              OR (event."eventType" IN ('provisioning_scan_found', 'provisioning_scan_completed', 'provisioning_scan_failed')
                AND event."createdAt" < ${cutoff(90)} AND EXISTS (
                  SELECT 1 FROM "ProvisioningSession" session
                  JOIN "GatewayEventWatermark" terminal
                    ON terminal."gatewayId" = session."gatewayId" AND terminal."eventType" = session."scanTerminalEventType"
                    AND terminal."scopeKey" = ''
                  WHERE session."id" = event."scopeKey" AND session."gatewayId" = event."gatewayId"
                    AND session."status" IN ('completed', 'failed', 'cancelled')
                    AND ((session."scanStatus" = 'completed' AND session."scanTerminalEventType" = 'provisioning_scan_completed')
                      OR (session."scanStatus" = 'failed' AND session."scanTerminalEventType" = 'provisioning_scan_failed'))
                    AND session."scanTerminalEventId" IS NOT NULL AND session."scanTerminalPayloadHash" IS NOT NULL
                    AND session."scanTerminalIngestedAt" IS NOT NULL AND session."scanCompletedAt" IS NOT NULL
                    AND terminal."lastPayloadHash" IS NOT NULL
                    AND terminal."lastSequence" >= session."scanTerminalSequence"
                    AND (terminal."lastSequence" > session."scanTerminalSequence" OR (
                      terminal."lastEventId" = session."scanTerminalEventId"
                      AND terminal."lastPayloadHash" = session."scanTerminalPayloadHash"
                      AND terminal."lastOccurredAt" = session."scanCompletedAt"
                    ))
                    AND (event."eventType" = 'provisioning_scan_found' OR (
                      session."scanTerminalEventId" = event."eventId" AND session."scanTerminalSequence" = event."sequence"
                      AND session."scanTerminalEventType" = event."eventType"
                      AND session."scanTerminalPayloadHash" = event."payloadHash" AND session."scanCompletedAt" = event."occurredAt"
                    ))
                ))
              OR (event."eventType" = 'vehicle_sensor_capability' AND event."createdAt" < ${cutoff(365)}
                AND watermark."lastSequence" > event."sequence" AND EXISTS (
                  SELECT 1 FROM "MeshNode" node WHERE node."id" = event."scopeKey" AND node."id" = event."meshNodeId"
                    AND node."gatewayId" = event."gatewayId" AND node."vehicleSensorCapabilityRevision" > event."sequence"
                    AND node."vehicleSensorCapabilityVerifiedAt" IS NOT NULL
                ))
            )
          ORDER BY event."createdAt", event."eventId" LIMIT 10000 FOR UPDATE OF event SKIP LOCKED
        )
        DELETE FROM "ProcessedGatewayEvent" event USING candidates WHERE event."eventId" = candidates."eventId"
      `);

      stage = "sessions";
      deleted.sessions = await this.prisma.$executeRaw(Prisma.sql`
        WITH candidates AS (
          SELECT "id" FROM "Session" WHERE "expiresAt" < ${cutoff(30)} OR "revokedAt" < ${cutoff(30)}
          ORDER BY LEAST("expiresAt", "revokedAt"), "id" LIMIT 10000 FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "Session" session USING candidates WHERE session."id" = candidates."id"
      `);

      stage = "floorMapRevisions";
      // revision is monotonic per floor, including restores. Using its existing
      // unique index protects the latest 100 even when createdAt values tie.
      deleted.floorMapRevisions = await this.prisma.$executeRaw(Prisma.sql`
        WITH candidates AS (
          SELECT revision."id" FROM "FloorMapRevision" revision
          WHERE revision."createdAt" < ${cutoff(365)} AND revision."revision" < (
            SELECT latest."revision" FROM "FloorMapRevision" latest WHERE latest."floorId" = revision."floorId"
            ORDER BY latest."revision" DESC OFFSET 99 LIMIT 1
          )
          ORDER BY revision."createdAt", revision."id" LIMIT 1000 FOR UPDATE OF revision SKIP LOCKED
        )
        DELETE FROM "FloorMapRevision" revision USING candidates WHERE revision."id" = candidates."id"
      `);

      stage = "monitoringRefreshes";
      // Preserve the existing 10,000 + 10,000 + 1,000 parent-row sweep budget.
      // Cascaded batch, fixture-result, request-alias and outbox rows are owned
      // by the terminal aggregate; no live Fixture/Gateway row is deleted/locked.
      const remaining = Math.min(1000, SWEEP_DELETE_BUDGET - deleted.gatewayEvents - deleted.sessions - deleted.floorMapRevisions);
      if (remaining > 0) {
        deleted.monitoringRefreshes = await this.prisma.$executeRaw(Prisma.sql`
          WITH candidates AS (
            SELECT "id" FROM "MonitoringRefresh"
            WHERE "status" IN ('completed', 'partial', 'failed', 'expired')
              AND "completedAt" < ${cutoff(7)}
            ORDER BY "completedAt", "id" LIMIT ${remaining} FOR UPDATE SKIP LOCKED
          )
          DELETE FROM "MonitoringRefresh" refresh USING candidates
          WHERE refresh."id" = candidates."id"
            AND refresh."status" IN ('completed', 'partial', 'failed', 'expired')
            AND refresh."completedAt" < ${cutoff(7)}
        `);
      }
      this.logger.log({ event: "data_retention_sweep", status: "completed", asOf: now.toISOString(),
        durationMs: Date.now() - started, deleted });
      return deleted;
    } catch (error) {
      // Keep raw SQL, row values and connection details out of operational logs.
      this.logger.warn({ event: "data_retention_sweep", status: "failed", asOf: now.toISOString(),
        durationMs: Date.now() - started, failedStage: stage, deleted });
      throw error;
    }
  }
}
