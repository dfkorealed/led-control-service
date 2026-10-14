import { bioPulseExecutionEventV2Schema, mqttTopics } from "@led-control/shared";
import { ingestBioPulseTelemetry } from "./bio-pulse-telemetry";
import { canonicalPayloadHash } from "./automation-payload-hash";

const siteId = "00000000-0000-4000-8000-000000000001";
const gatewayId = "00000000-0000-4000-8000-000000000002";
const source = "00000000-0000-4000-8000-000000000003";
const target = "00000000-0000-4000-8000-000000000004";
const node = "00000000-0000-4000-8000-000000000005";
const ruleId = "00000000-0000-4000-8000-000000000006";
const event = bioPulseExecutionEventV2Schema.parse({ schemaVersion: 2, assignmentVersion: 1, eventId: "00000000-0000-4000-8000-000000000007",
  sequence: 1, gatewayId, revision: 4, ruleId, occurrenceKey: "occurrence", occurredAt: "2026-10-14T00:00:01.000Z", kind: "action_result",
  payload: { sensorProtocol: "bio-usb-pulse", verification: "configuration_readback", phase: "restore",
    results: [{ fixtureId: target, status: "succeeded", configuration: { configuredHighBrightnessPercent: 30, bioMode: "sensor" } }] } });

function harness(version: 2 | 3) {
  const body = { schemaVersion: version, siteId, gatewayId, revision: 4, timeZone: "Asia/Seoul", generatedAt: "2026-10-14T00:00:00.000Z",
    schedules: [], vehicleEventRules: [{ id: ruleId, name: "BIO", status: "enabled", sensorProtocol: "bio-usb-pulse", sourceFixtureIds: [source], targetFixtureIds: [target],
      action: { dimmingEnabled: true, brightnessPercent: 70 }, holdSeconds: 10 }], ...(version === 3 ? { holidayDatasets: [] } : {}) };
  const row = { payload: { ...body, payloadHash: canonicalPayloadHash(body) }, payloadHash: canonicalPayloadHash(body),
    topic: mqttTopics.automationConfig(siteId, gatewayId), automationSourceBindings: { [source]: node } };
  const state = { events: [] as any[], acknowledgements: [] as any[], projection: null as any };
  const tx = { $executeRaw: async () => 1, $queryRaw: async () => [{ assignmentVersion: 1 }],
    gatewayAutomationProtocolSupport: { findFirst: async () => ({ maxSnapshotVersion: version, temporaryControlVersion: 1, bioConfigurationReadback: true, durableFixtureLease: true }) },
    gatewayAutomationConfiguration: { findUnique: async () => ({ desiredRevision: 4 }) },
    fixture: { findFirst: async () => ({ meshNodeId: node }), findMany: async () => [{ id: source, meshNode: { vehicleSensorProtocol: "bio_usb_pulse" } }, { id: target, meshNode: {} }] },
    bioPulseTelemetryEvent: { findFirst: async () => null, create: async ({ data }: any) => { state.events.push(data); return data; } },
    bioPulseTelemetryProjection: { findUnique: async () => null, upsert: async ({ create }: any) => { state.projection = create; } },
    mqttOutbox: { findMany: async () => [row], findUnique: async () => null, create: async ({ data }: any) => { state.acknowledgements.push(data); } } };
  return { tx, row, state };
}

describe("BIO wire2 telemetry consuming known V2/V3 snapshots", () => {
  it.each([2, 3] as const)("binds exact V%s source/envelope and keeps ACK wire2", async version => {
    const h = harness(version);
    const ack = await ingestBioPulseTelemetry(h.tx as never, { siteId, gatewayId, channel: "events/automation/execution" } as never, event, new Date("2026-10-14T00:00:02Z"));
    expect(ack).toMatchObject({ schemaVersion: 2, eventId: event.eventId, sequence: 1 });
    expect(h.state.events).toHaveLength(1); expect(h.state.events[0]).toMatchObject({ sourceFixtureId: source, targetFixtureIds: [target], disposition: "accepted" });
    expect(h.state.events[0]).not.toHaveProperty("channel");
    expect(h.state.projection.configurationReadback).toMatchObject({ verification: "configuration_readback" });
    expect(h.state.acknowledgements[0].topic).toBe(mqttTopics.automationExecutionIngested(siteId, gatewayId));
  });
  it.each(["hash", "binding", "scope"])("does not acknowledge or project a V3 %s mismatch", async mismatch => {
    const h = harness(3);
    if (mismatch === "hash") h.row.payloadHash = `sha256:${"f".repeat(64)}`;
    if (mismatch === "binding") h.row.automationSourceBindings = {} as never;
    if (mismatch === "scope") h.row.payload.siteId = target;
    await ingestBioPulseTelemetry(h.tx as never, { siteId, gatewayId }, event, new Date("2026-10-14T00:00:02Z"));
    expect(h.state.events).toEqual([]); expect(h.state.acknowledgements).toEqual([]);
  });
});
