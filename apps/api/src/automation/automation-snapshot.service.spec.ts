import { createHash } from "node:crypto";
import { AutomationSnapshotService } from "./automation-snapshot.service";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const GATEWAY_ID = "00000000-0000-4000-8000-000000000002";
const SCHEDULE_A = "00000000-0000-4000-8000-000000000003";
const SCHEDULE_B = "00000000-0000-4000-8000-000000000004";
const FIXTURE_A = "00000000-0000-4000-8000-000000000005";
const FIXTURE_B = "00000000-0000-4000-8000-000000000006";

describe("AutomationSnapshotService", () => {
  const generatedAt = new Date("2026-08-31T23:00:00.000Z");
  const service = new AutomationSnapshotService({ now: () => generatedAt } as never);

  it("acquires the shared automation lock through the database protocol", async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };

    await service.lockMutation(tx as never);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("writes a stable normalized full snapshot and independently verifiable dedup identity", async () => {
    const mqttOutboxCreate = jest.fn().mockResolvedValue({ id: "outbox" });
    const tx = {
      gateway: { findUnique: jest.fn().mockResolvedValue({
        id: GATEWAY_ID,
        siteId: SITE_ID,
        site: { timeZone: "Asia/Seoul" },
        automationConfiguration: { desiredRevision: 4, appliedRevision: 3 }
      }) },
      lightingSchedule: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        findMany: jest.fn().mockResolvedValue([
          scheduleRow(SCHEDULE_B, [FIXTURE_B]),
          scheduleRow(SCHEDULE_A, [FIXTURE_B, FIXTURE_A])
        ])
      },
      vehicleEventRule: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{
          id: "00000000-0000-4000-8000-000000000007",
          name: "Vehicle",
          status: "enabled",
          dimmingEnabled: false,
          brightnessPercent: 9,
          holdSeconds: 60,
          sources: [{ fixtureId: FIXTURE_B }, { fixtureId: FIXTURE_A }],
          targets: [{ fixtureId: FIXTURE_B }]
        }])
      },
      gatewayAutomationConfiguration: { upsert: jest.fn().mockResolvedValue({
        desiredRevision: 5,
        appliedRevision: 3,
        syncStatus: "PENDING"
      }) },
      mqttOutbox: { create: mqttOutboxCreate }
    };

    await expect(service.incrementDesiredRevision(tx as never, GATEWAY_ID)).resolves.toEqual({
      desiredRevision: 5,
      appliedRevision: 3,
      syncStatus: "PENDING"
    });

    const data = mqttOutboxCreate.mock.calls[0][0].data;
    const payload = data.payload as Record<string, unknown>;
    const { payloadHash, ...withoutHash } = payload;
    const independentlyComputed = `sha256:${createHash("sha256")
      .update(independentCanonicalJson(withoutHash))
      .digest("hex")}`;

    expect(payloadHash).toBe(independentlyComputed);
    expect(data).toMatchObject({
      gatewayId: GATEWAY_ID,
      revision: 5,
      payloadHash: independentlyComputed
    });
    expect(payload).toMatchObject({
      generatedAt: generatedAt.toISOString(),
      schedules: [
        expect.objectContaining({
          id: SCHEDULE_A,
          fixtureIds: [FIXTURE_A, FIXTURE_B],
          action: { dimmingEnabled: false, brightnessPercent: 100 }
        }),
        expect.objectContaining({ id: SCHEDULE_B })
      ],
      vehicleEventRules: [expect.objectContaining({
        sourceFixtureIds: [FIXTURE_A, FIXTURE_B],
        action: { dimmingEnabled: false, brightnessPercent: 100 }
      })]
    });
  });
});

function scheduleRow(id: string, fixtureIds: string[]) {
  return {
    id,
    name: id,
    status: "enabled",
    activeFrom: new Date("2026-09-01T00:00:00.000Z"),
    activeUntil: new Date("2026-09-30T00:00:00.000Z"),
    localStartTime: "09:00",
    localEndTime: "10:00",
    recurrenceKind: "daily",
    weeklyDays: [],
    monthlyDay: null,
    yearlyMonth: null,
    yearlyDay: null,
    dimmingEnabled: false,
    brightnessPercent: 7,
    fixtures: fixtureIds.map((fixtureId) => ({ fixtureId }))
  };
}

function independentCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${independentCanonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
