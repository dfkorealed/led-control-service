import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  fixturePresenceV2Schema,
  type ApplicationStateIngestedAckV2,
  type FixturePresenceV2
} from "@led-control/shared";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { gatewayEventIsTooFarInFuture, gatewayEventMaxFutureSkewMs } from "../mqtt/gateway-event-time";
import { PrismaService } from "../prisma/prisma.service";
import { compareAndAdvanceGatewayEvent } from "../retention/gateway-event-watermark";
import { recordMonitoringActivity } from "../monitoring-activity/monitoring-activity.projection";
import { assertRefreshWatermarkIdentity, lockRefreshObservation, resolveRefreshObservation } from "../monitoring-refresh/monitoring-refresh-ingestion.service";

type IngestionStatus = ApplicationStateIngestedAckV2["status"];

interface LockedFixtureRow {
  id: string;
  name: string;
  floorId: string;
  status: "online" | "offline" | "fault";
  lastUnreachableAt: Date | null;
  lastSeenAt: Date | null;
  lastPresenceOccurredAt: Date | null;
  statusReason: string | null;
  reportedStatus: "online" | "offline" | "fault";
  reportedStatusReason: string | null;
}

export interface FixturePresenceIngestionResult {
  eventId: string;
  sequence: number;
  fixtureId: string;
  status: IngestionStatus;
}

@Injectable()
export class FixturePresenceIngestionService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(
    gatewayId: string,
    input: FixturePresenceV2,
    receivedAt = new Date()
  ): Promise<FixturePresenceIngestionResult> {
    const presence = fixturePresenceV2Schema.parse(input);
    const frozenReceivedAt = new Date(receivedAt.getTime());
    const maxFutureSkewMs = gatewayEventMaxFutureSkewMs();
    const payloadHash = canonicalPayloadHash(presence);
    try {
      return await this.prisma.$transaction(
        async (tx) => this.ingestInTransaction(tx, gatewayId, presence, frozenReceivedAt, maxFutureSkewMs, payloadHash),
        { timeout: 10_000 }
      );
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const duplicate = await this.prisma.processedGatewayEvent.findUnique({ where: { eventId: presence.eventId } });
      if (!duplicate || !sameProcessedEvent(duplicate, gatewayId, presence, payloadHash)) {
        throw new Error("fixture presence event identity conflict");
      }
      return resultFrom(presence, duplicate.ingestionStatus === "rejected_future_timestamp"
        ? "rejected_future_timestamp" : "duplicate");
    }
  }

  private async ingestInTransaction(
    tx: Prisma.TransactionClient,
    gatewayId: string,
    presence: FixturePresenceV2,
    receivedAt: Date,
    maxFutureSkewMs: number,
    payloadHash: string
  ): Promise<FixturePresenceIngestionResult> {
    const existing = await tx.processedGatewayEvent.findUnique({ where: { eventId: presence.eventId } });
    if (existing) {
      if (!sameProcessedEvent(existing, gatewayId, presence, payloadHash)) {
        throw new Error("fixture presence event identity conflict");
      }
      return resultFrom(presence, existing.ingestionStatus === "rejected_future_timestamp"
        ? "rejected_future_timestamp" : "duplicate");
    }

    if (gatewayId !== presence.gatewayId) throw new Error("fixture presence scope rejected");

    // freshness sweep과 state ingestion도 Site를 먼저 잡는다. Gateway의 복합 FK와
    // Fixture의 소유 관계를 거꾸로 잠그면 sweep(Site→Gateway→Fixture)과 대기 순서가
    // 엇갈릴 수 있으므로, presence처럼 짧은 쓰기도 이 비표준적인 부모 우선 순서를 지킨다.
    const [site] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Site"
      WHERE "id" = ${presence.siteId}
      FOR KEY SHARE
    `);
    if (!site) throw new Error("fixture presence scope rejected");

    const [gateway] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Gateway"
      WHERE "id" = ${gatewayId}
        AND "siteId" = ${presence.siteId}
      FOR KEY SHARE
    `);
    if (!gateway) throw new Error("fixture presence scope rejected");

    const [fixture] = await tx.$queryRaw<LockedFixtureRow[]>(Prisma.sql`
      SELECT f."id", f."name", f."floorId", f."status", f."lastUnreachableAt", f."lastSeenAt", f."lastPresenceOccurredAt", f."statusReason",
        f."reportedStatus", f."reportedStatusReason"
      FROM "Fixture" f
      INNER JOIN "Floor" fl ON fl."id" = f."floorId"
      INNER JOIN "MeshNode" mn ON mn."id" = f."meshNodeId"
      WHERE f."id" = ${presence.fixtureId}
        AND fl."siteId" = ${presence.siteId}
        AND mn."gatewayId" = ${gatewayId}
      FOR UPDATE OF f
    `);
    const refreshContext = presence.refreshId && presence.batchId
      ? await lockRefreshObservation(tx, { ...presence, refreshId: presence.refreshId, batchId: presence.batchId }, fixture?.floorId)
      : null;
    // A retained Gateway receipt can outlive both the refresh and its fixture. A confirmed
    // retired correlation is acknowledged without reviving liveness or writing any ledger.
    if (presence.refreshId && !refreshContext) {
      await assertRefreshWatermarkIdentity(tx, presence, "fixture_presence", presence.fixtureId);
      return resultFrom(presence, "duplicate");
    }
    if (!fixture) throw new Error("fixture presence scope rejected");

    // 같은 eventId를 동시에 받으면 후발 transaction은 Fixture 잠금 뒤에 선행
    // transaction의 원장을 다시 읽는다. 그러면 unique-index 예외를 정상 ACK 경로로
    // 쓰지 않아도 되고, 원장의 확정 결과가 항상 우선한다.
    const committedDuringFixtureLock = await tx.processedGatewayEvent.findUnique({ where: { eventId: presence.eventId } });
    if (committedDuringFixtureLock) {
      if (!sameProcessedEvent(committedDuringFixtureLock, gatewayId, presence, payloadHash)) {
        throw new Error("fixture presence event identity conflict");
      }
      return resultFrom(presence, committedDuringFixtureLock.ingestionStatus === "rejected_future_timestamp"
        ? "rejected_future_timestamp" : "duplicate");
    }

    const occurredAt = new Date(presence.occurredAt);
    if (gatewayEventIsTooFarInFuture(occurredAt, receivedAt, maxFutureSkewMs)) {
      await createLedger(tx, gatewayId, presence, payloadHash, occurredAt, receivedAt, "rejected_future_timestamp");
      return resultFrom(presence, "rejected_future_timestamp");
    }

    // sequence가 증가했더라도 과거 관측 시간을 최신 checkpoint로 되돌리면 다음
    // freshness 판정이 실제보다 오래된 값을 보게 된다. timestamp 역행은 watermark를
    // 전진시키지 않고 ACK 가능한 stale 결과만 남긴다. 단, watermark만 남은 eventId의
    // 동일 sequence도 먼저 대조해야 한다. 이를 생략하면 변조된 과거 payload가 stale
    // ACK로 원장을 새로 만들어 재전송 무결성 경계를 우회할 수 있다.
    if (fixture.lastPresenceOccurredAt && occurredAt < fixture.lastPresenceOccurredAt) {
      const reverseOrdering = await compareReverseTimeWatermark(tx, gatewayId, presence, payloadHash, occurredAt);
      if (reverseOrdering === "conflict") throw new Error("fixture presence event identity conflict");
      if (reverseOrdering === "duplicate") return resultFrom(presence, "duplicate");
      await createLedger(tx, gatewayId, presence, payloadHash, occurredAt, receivedAt, "accepted");
      return resultFrom(presence, "stale_sequence");
    }

    const ordering = await compareAndAdvanceGatewayEvent(tx, {
      gatewayId,
      eventType: "fixture_presence",
      scopeKey: presence.fixtureId,
      sequence: BigInt(presence.sequence),
      eventId: presence.eventId,
      payloadHash,
      occurredAt
    });
    if (ordering === "conflict") throw new Error("fixture presence event identity conflict");
    if (ordering === "duplicate") return resultFrom(presence, "duplicate");

    await createLedger(tx, gatewayId, presence, payloadHash, occurredAt, receivedAt, "accepted");
    if (ordering === "stale") return resultFrom(presence, "stale_sequence");

    // BIO sensor mode의 high brightness는 장치에 저장된 설정값이지 현재 LED 출력이
    // 아니다. presence를 brightness/powerOn 또는 energy checkpoint로 옮기면 꺼진
    // 조명을 켜진 것으로 추정해 전력 집계를 오염시킬 수 있으므로 이 transaction은
    // liveness와 BIO readback metadata만 갱신하며 energy helper를 호출하지 않는다.
    const freshnessResolved = (!fixture.lastUnreachableAt || receivedAt > fixture.lastUnreachableAt) &&
      (fixture.statusReason === "fixture_stale" || fixture.statusReason === "gateway_offline");
    const restoredStatus = freshnessResolved ? restoreReportedOperationalState(fixture).status : fixture.status;
    await tx.fixture.update({
      where: { id: fixture.id },
      data: {
        lastSeenAt: fixture.lastSeenAt && fixture.lastSeenAt > receivedAt ? fixture.lastSeenAt : receivedAt,
        ...(!fixture.lastUnreachableAt || receivedAt > fixture.lastUnreachableAt ? { lastUnreachableAt: null } : {}),
        rssi: presence.rssi,
        hopCount: presence.hopCount,
        bioControlMode: presence.controlMode,
        bioConfiguredBrightness: presence.configuredBrightness,
        bioRawHighBrightness: presence.rawHighBrightness,
        lastPresenceEventId: presence.eventId,
        lastPresenceSequence: BigInt(presence.sequence),
        lastPresenceOccurredAt: occurredAt,
        ...((!fixture.lastUnreachableAt || receivedAt > fixture.lastUnreachableAt) &&
          (fixture.statusReason === "fixture_stale" || fixture.statusReason === "gateway_offline")
          ? restoreReportedOperationalState(fixture)
          : {})
      }
    });
    if (freshnessResolved && fixture.status !== restoredStatus) {
      await recordMonitoringActivity(tx, { siteId: presence.siteId, floorId: fixture.floorId,
        fixtureId: fixture.id, displayName: fixture.name, sourceType: "fixture_presence",
        sourceKey: presence.eventId, kind: restoredStatus === "online" ? "fixture_online" : "fixture_status_changed",
        status: restoredStatus, observedAt: occurredAt });
    }
    if (!fixture.lastUnreachableAt || receivedAt > fixture.lastUnreachableAt) {
      await resolveRefreshObservation(tx, refreshContext, receivedAt);
    }
    return resultFrom(presence, "ingested");
  }
}

function restoreReportedOperationalState(fixture: Pick<LockedFixtureRow, "reportedStatus" | "reportedStatusReason">) {
  // [확인됨] Fixture는 두 층의 상태를 보관한다. status/statusReason은 freshness
  // worker가 일시적으로 gateway_offline/fixture_stale로 덮는 운영 상태이고,
  // reportedStatus/reportedStatusReason은 마지막 실제 fixture-state의 결과다.
  // BIO presence는 GET 성공이라는 생존 증거일 뿐 명령 성공·fault 해제·등록 완료나
  // 실제 LED 출력 관측이 아니다. 따라서 freshness-only 상태에서만 원래 보고 상태를
  // 복원하며, command_failed/fault/provisioning blocker를 online으로 만들지 않는다.
  // reportedStatus는 DB non-null enum이므로 별도 추정값을 만들지 않는다. 다만 이유가
  // 없는 정상 online 보고만 기존 호환 표기인 online/reported로 정규화한다.
  if (fixture.reportedStatus === "online" && (fixture.reportedStatusReason === null || fixture.reportedStatusReason === "reported")) {
    return { status: "online" as const, statusReason: "reported" };
  }
  return { status: fixture.reportedStatus, statusReason: fixture.reportedStatusReason ?? "reported" };
}

async function compareReverseTimeWatermark(
  tx: Prisma.TransactionClient,
  gatewayId: string,
  presence: FixturePresenceV2,
  payloadHash: string,
  occurredAt: Date
): Promise<"stale" | "duplicate" | "conflict"> {
  const key = { gatewayId, eventType: "fixture_presence", scopeKey: presence.fixtureId };
  // compareAndAdvanceGatewayEvent normally owns this lookup and the advisory
  // lock. Reverse-time reports deliberately must not advance the watermark,
  // so perform only its identity checks here before recording a stale outcome.
  const collision = await tx.gatewayEventWatermark.findFirst({ where: { lastEventId: presence.eventId, NOT: key } });
  if (collision) return "conflict";
  const current = await tx.gatewayEventWatermark.findUnique({ where: { gatewayId_eventType_scopeKey: key } });
  if (!current) return "stale";

  const sequence = BigInt(presence.sequence);
  if (current.lastEventId === presence.eventId && sequence !== current.lastSequence) return "conflict";
  if (sequence < current.lastSequence) return "stale";
  if (sequence > current.lastSequence) return "stale";
  return current.lastEventId === presence.eventId && current.lastPayloadHash === payloadHash &&
    current.lastOccurredAt.getTime() === occurredAt.getTime() ? "duplicate" : "conflict";
}

function createLedger(
  tx: Prisma.TransactionClient,
  gatewayId: string,
  presence: FixturePresenceV2,
  payloadHash: string,
  occurredAt: Date,
  receivedAt: Date,
  ingestionStatus: "accepted" | "rejected_future_timestamp"
) {
  return tx.processedGatewayEvent.create({
    data: {
      eventId: presence.eventId,
      gatewayId,
      fixtureId: presence.fixtureId,
      sequence: BigInt(presence.sequence),
      eventType: "fixture_presence",
      payloadHash,
      scopeKey: presence.fixtureId,
      occurredAt,
      receivedAt,
      ingestionStatus
    }
  });
}

function resultFrom(presence: FixturePresenceV2, status: IngestionStatus): FixturePresenceIngestionResult {
  return { eventId: presence.eventId, sequence: presence.sequence, fixtureId: presence.fixtureId, status };
}

function sameProcessedEvent(
  event: { gatewayId: string; fixtureId: string | null; sequence: bigint; eventType: string; occurredAt: Date; payloadHash: string | null },
  gatewayId: string,
  presence: FixturePresenceV2,
  payloadHash: string
) {
  return event.gatewayId === gatewayId && event.fixtureId === presence.fixtureId &&
    event.sequence === BigInt(presence.sequence) && event.eventType === "fixture_presence" &&
    event.occurredAt.getTime() === new Date(presence.occurredAt).getTime() && event.payloadHash === payloadHash;
}

function isUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
