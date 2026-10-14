import { createHash } from "node:crypto";
import { AutomationSnapshotService } from "./automation-snapshot.service";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const GATEWAY_ID = "00000000-0000-4000-8000-000000000002";
const SCHEDULE_A = "00000000-0000-4000-8000-000000000003";
const SCHEDULE_B = "00000000-0000-4000-8000-000000000004";
const FIXTURE_A = "00000000-0000-4000-8000-000000000005";
const FIXTURE_B = "00000000-0000-4000-8000-000000000006";

describe("AutomationSnapshotService", () => {
  it("serializes a strict V3 snapshot with explicit exclusion flags and preserves source bindings", async () => {
    const payloads: any[] = [];
    const tx = {
      gateway: { findUnique: async () => ({ id: GATEWAY_ID, siteId: SITE_ID, assignmentVersion: 1, site: { timeZone: "Asia/Seoul" }, automationConfiguration: null,
        inventory: { id: "inventory", claimedAt: new Date(), disabledAt: null }, certificates: [{ inventoryId: "inventory" }],
        automationProtocolDeclarations: [{ assignmentVersion: 1, maxSnapshotVersion: 3, temporaryControlVersion: 1, bioConfigurationReadback: true, durableFixtureLease: true }] }) },
      lightingSchedule: { updateMany: async () => ({}), findMany: async () => [{ id: SCHEDULE_A, name: "new", status: "enabled", activeFrom: new Date("2026-01-01Z"),
        activeUntil: new Date("2026-12-31Z"), localStartTime: "08:00", localEndTime: "09:00", recurrenceKind: "daily", weeklyDays: [], monthlyDay: null,
        yearlyMonth: null, yearlyDay: null, dimmingEnabled: true, brightnessPercent: 70, fixtures: [{ fixtureId: FIXTURE_A }], excludeWeekends: true, excludeHolidays: false }] },
      vehicleEventRule: { updateMany: async () => ({}), findMany: async () => [] }, gatewayAutomationConfiguration: { upsert: async () => ({}) },
      mqttOutbox: { create: async ({ data }: any) => { payloads.push(data); } }
    };
    await new AutomationSnapshotService({ now: () => new Date("2026-10-14Z") }).incrementDesiredRevision(tx as never, GATEWAY_ID);
    expect(payloads[0]).toMatchObject({ automationAssignmentVersion: 1, automationSourceBindings: {},
      payload: { schemaVersion: 3, holidayDatasets: [], schedules: [{ excludeWeekends: true, excludeHolidays: false }] } });
  });
  const generatedAt = new Date("2026-08-31T23:00:00.000Z");
  const service = new AutomationSnapshotService({ now: () => generatedAt } as never);

  it("acquires the shared automation lock through the database protocol", async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };

    await service.lockMutation(tx as never);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["bio_usb_pulse", "enabled", "bio_usb_pulse", "enabled", false],
    ["bio_usb_pulse", "enabled", "bluez_stateful", "enabled", false],
    ["bluez_stateful", "enabled", "bio_usb_pulse", "enabled", false],
    ["bio_usb_pulse", "enabled", "bio_usb_pulse", "disabled", true],
    ["bio_usb_pulse", "enabled", "bluez_stateful", "disabled", true],
    ["bio_usb_pulse", "disabled", "bluez_stateful", "enabled", true],
    ["bluez_stateful", "enabled", "bluez_stateful", "enabled", true]
  ])("Task6: target reservation %s/%s against %s/%s (allowed=%s)", async (leftProtocol, leftStatus, rightProtocol, rightStatus, allowed) => {
    // Catch active BIO overlap in either rule order, without reserving disabled
    // drafts or changing legacy BlueZ/BlueZ arbitration. Resolve IDs upstream.
    const rows = [
      { id: SCHEDULE_A, sensorProtocol: leftProtocol, status: leftStatus, targets: [{ fixtureId: FIXTURE_A }, { fixtureId: FIXTURE_B }] },
      { id: SCHEDULE_B, sensorProtocol: rightProtocol, status: rightStatus, targets: [{ fixtureId: FIXTURE_B }] }
    ].map(row => ({ ...row, name: "Synthetic rule", dimmingEnabled: true, brightnessPercent: 75, holdSeconds: 10,
      sources: [{ fixtureId: FIXTURE_A, fixture: { meshNodeId: FIXTURE_A } }] }));
    const payloads: any[] = []; let configurationWritten = false;
    const tx = {
      gateway: { findUnique: async () => ({ id: GATEWAY_ID, siteId: SITE_ID, assignmentVersion: 1,
        site: { timeZone: "Asia/Seoul" }, automationConfiguration: null,
        inventory: { id: "synthetic", claimedAt: generatedAt, disabledAt: null },
        certificates: [{ inventoryId: "synthetic" }],
        automationProtocolDeclarations: [{ assignmentVersion: 1, maxSnapshotVersion: 2 }] }) },
      lightingSchedule: { updateMany: async () => ({}), findMany: async () => [] },
      vehicleEventRule: { updateMany: async () => ({}), findMany: async () => rows },
      gatewayAutomationConfiguration: { upsert: async () => { configurationWritten = true; return {}; } },
      mqttOutbox: { create: async ({ data }: any) => { payloads.push(data.payload); } }
    };
    if (allowed) {
      await service.incrementDesiredRevision(tx as never, GATEWAY_ID);
      expect(payloads[0].vehicleEventRules.map((rule: any) => rule.status)).toEqual([leftStatus, rightStatus]);
    } else {
      await expect(service.incrementDesiredRevision(tx as never, GATEWAY_ID)).rejects.toMatchObject({
        response: { code: "bio_target_activation_conflict", message: expect.any(String) }
      });
      expect(configurationWritten).toBe(false); expect(payloads).toEqual([]);
    }
  });

  it("excludes BIO drafts from V1 even when a Gateway has BlueZ rules", async () => {
    const tx = {
      gateway: { findUnique: async () => ({ id: GATEWAY_ID, siteId: SITE_ID,
        site: { timeZone: "Asia/Seoul" }, automationConfiguration: null }) },
      lightingSchedule: { updateMany: async () => ({}), findMany: async () => [] },
      vehicleEventRule: { updateMany: async () => ({}), findMany: async () => [{
        id: SCHEDULE_A, name: "BIO", sensorProtocol: "bio_usb_pulse", status: "disabled",
        dimmingEnabled: true, brightnessPercent: 70, holdSeconds: 60,
        sources: [{ fixtureId: FIXTURE_A }], targets: [{ fixtureId: FIXTURE_B }]
      }] },
      gatewayAutomationConfiguration: { upsert: async () => ({}) },
      mqttOutbox: { create: jest.fn(async () => ({})) }
    };
    await service.incrementDesiredRevision(tx as never, GATEWAY_ID);
    expect((tx.mqttOutbox.create.mock.calls as unknown as Array<[{ data: { payload: unknown } }]>)[0][0].data.payload)
      .toMatchObject({ schemaVersion: 1, vehicleEventRules: [] });
  });

  it("publishes BIO only as V2 after a current authenticated explicit declaration", async () => {
    const gateway = { id: GATEWAY_ID, siteId: SITE_ID, assignmentVersion: 2,
      site: { timeZone: "Asia/Seoul" }, automationConfiguration: null,
      inventory: { id: "claimed-inventory", claimedAt: generatedAt, disabledAt: null },
      certificates: [{ id: "active", inventoryId: "claimed-inventory" }],
      automationProtocolDeclarations: [{ assignmentVersion: 2, maxSnapshotVersion: 2 }] };
    const payloads: any[] = [];
    const tx = {
      gateway: { findUnique: async () => gateway },
      lightingSchedule: { updateMany: async () => ({}), findMany: async () => [] },
      vehicleEventRule: { updateMany: async () => ({}), findMany: async () => [{
        id: SCHEDULE_A, name: "BIO", sensorProtocol: "bio_usb_pulse", status: "disabled",
        dimmingEnabled: true, brightnessPercent: 70, holdSeconds: 10,
        sources: [{ fixtureId: FIXTURE_A, fixture: { meshNodeId: "00000000-0000-4000-8000-000000000009" } }], targets: [{ fixtureId: FIXTURE_B }]
      }] },
      gatewayAutomationConfiguration: { upsert: async () => ({}) },
      mqttOutbox: { create: async ({ data }: any) => { payloads.push(data.payload); } }
    };
    await service.incrementDesiredRevision(tx as never, GATEWAY_ID);
    expect(payloads[0]).toMatchObject({ schemaVersion: 2,
      vehicleEventRules: [{ sensorProtocol: "bio-usb-pulse", holdSeconds: 10, status: "disabled" }] });
    const { payloadHash, ...body } = payloads[0];
    expect(payloadHash).toBe(`sha256:${createHash("sha256").update(independentCanonicalJson(body)).digest("hex")}`);
    gateway.assignmentVersion = 3;
    await service.incrementDesiredRevision(tx as never, GATEWAY_ID);
    expect(payloads[1]).toMatchObject({ schemaVersion: 1, vehicleEventRules: [] });
    gateway.assignmentVersion = 2;
    gateway.certificates[0].inventoryId = "unrelated-inventory";
    await service.incrementDesiredRevision(tx as never, GATEWAY_ID);
    expect(payloads[2]).toMatchObject({ schemaVersion: 1, vehicleEventRules: [] });
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
