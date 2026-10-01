import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mqttTopics, type AutomationSnapshotV2 } from "@led-control/shared";
import { encodeCrcFrame } from "../bio/bio-frame-codec";
import { BIO_SENSOR_PULSE_PROFILES } from "../bio/bio-sensor-pulse-intake";
import type { BioConfigurationState, BioVerifiedLampTarget } from "../bio/bio-dongle-client";
import { createSoftwareAutomationSimulator, createSoftwareBioPulseInput } from "./software-automation-simulator";
import { FileAutomationStateStore } from "./automation-state-store";
import { ScheduleRuntime } from "./schedule-runtime";
import type { BioSourceAuthority } from "./bio-pulse-scheduler";
import { AutomationTelemetryCoordinator } from "./automation-telemetry-coordinator";
import { AutomationTelemetryOutbox, AutomationTelemetryPublisher } from "./automation-telemetry-outbox";

const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const ruleId = "00000000-0000-4000-8000-000000000003";
const scope = { siteId: a, gatewayId: b };
const profile = { id: "synthetic-only", firmwareFingerprint: "test-fw", sensorFingerprint: "test-sensor", bodyHex: "aabb" };
const directories: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

// Hand-built synthetic notification, not a captured/HIL-approved body or identity.
function frame(sequence: number, opcode = 0x09, body = "aabb") {
  const header = Buffer.from("d60011223344558300000101fe000209", "hex");
  header[8] = sequence; header[15] = opcode;
  return encodeCrcFrame(0x12, Buffer.concat([header, Buffer.from(body, "hex")]));
}

async function fixture(holdSeconds = 10) {
  const directory = await mkdtemp(join(tmpdir(), "bio-software-integration-")); directories.push(directory);
  const simulator = createSoftwareAutomationSimulator({ nodeEnv: "test", enabled: true })!;
  // Exact receipt boundaries share advances with the existing simulator wall clock.
  let ms = 1000;
  const advance = (amount: number) => { simulator.advanceClock(amount); ms += amount; };
  const binding = { sourceFixtureId: a, nativeUuid: "001122334455", logicalAddress: 1, networkId: 2,
    capabilityRevision: 1, snapshotRevision: 4, profileId: profile.id,
    firmwareFingerprint: profile.firmwareFingerprint, sensorFingerprint: profile.sensorFingerprint };
  const authority: BioSourceAuthority = { binding, independentlyQualified: true,
    connection: { epoch: "synthetic-connection", generation: 1 },
    observation: { health: "healthy", reason: "synthetic-independent-health", connectionEpoch: "synthetic-connection",
      connectionGeneration: 1, healthySinceMonotonicMs: 0 } };
  const payload = { schemaVersion: 2 as const, ...scope, revision: 4, timeZone: "UTC", schedules: [],
    vehicleEventRules: [{ id: ruleId, name: "Synthetic only", status: "enabled" as const, sensorProtocol: "bio-usb-pulse" as const,
      sourceFixtureIds: [a], targetFixtureIds: [b], action: { dimmingEnabled: true, brightnessPercent: 80 }, holdSeconds }],
    generatedAt: simulator.wallClock().toISOString() };
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([l], [r]) => l.localeCompare(r)).map(([key, child]) => [key, canonical(child)])) : value;
  const snapshot: AutomationSnapshotV2 = { ...payload, payloadHash: `sha256:${createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex")}` };
  const target: BioVerifiedLampTarget = { kind: "unicast", nativeUuid: "001122334466", logicalAddress: 2, networkId: 2 };
  let configuration: BioConfigurationState = { configuredHighBrightnessPercent: 30, bioMode: "sensor" };
  const writes: Array<{ fixtureId: string; configuration: BioConfigurationState }> = [];
  const outboxPath = join(directory, "telemetry.json");
  const outbox = new AutomationTelemetryOutbox(outboxPath, scope, { headroomBytes: 16384 });
  await outbox.initialize();
  const make = async () => {
    const store = new FileAutomationStateStore(join(directory, "state.json"));
    const coordinator = new AutomationTelemetryCoordinator(store, outbox);
    cleanup.push(async () => coordinator.stop());
    const runtime = new ScheduleRuntime({ store, wallClock: simulator.wallClock, monotonicClock: () => ms,
      clockTrust: simulator.clockTrust, execute: async () => { throw new Error("unexpected generic RF write"); },
      flushTelemetryHandoffs: async () => { await coordinator.flush(snapshot.revision); },
      bioPulseTestProfile: { kind: "synthetic-test-only", bindings: [binding], sourceAuthority: () => structuredClone(authority),
        targetPort: {
          async readBioState(id) { if (id !== b) throw new Error("unexpected source read"); return { target, configuration: { ...configuration } }; },
          async restoreBioState(id, actualTarget, desired) {
            expect(actualTarget).toEqual(target);
            expect(store.read().bioTargetsByFixture[id]?.preState).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
            writes.push({ fixtureId: id, configuration: { ...desired } }); configuration = { ...desired }; return configuration;
          }
        } }
    });
    await runtime.initialize(); await runtime.activateBioPulseTestSnapshot(snapshot);
    const inputOptions = { nodeEnv: "test", enabled: true, kind: "synthetic-test-only" as const,
      sourceFixtureId: a, mapping: { status: "confirmed" as const, ...binding, deviceUuid: `bio:${binding.nativeUuid}`, approvedProfileId: profile.id },
      profiles: [profile], monotonicClock: () => ms,
      health: () => ({ transportConnected: authority.observation.health === "healthy", protocolReady: true,
        independentLivenessVerified: authority.independentlyQualified, generation: authority.connection.generation }),
      connection: () => authority.connection,
      onPulse: runtime.recordVehicleSensorInput.bind(runtime) };
    return { runtime, store, inputOptions, input: createSoftwareBioPulseInput(inputOptions)! };
  };
  const current = await make();
  return { ...current, make, advance, authority, writes, outbox, outboxPath, snapshot, configuration: () => configuration };
}

describe("BIO synthetic frame integration (separate from product config acceptance)", () => {
  it.each([10, 60])("decodes CRC/0x09 through intake, extends %ss, and restores B mode without writing A", async hold => {
    const f = await fixture(hold);
    expect(await f.input.injectFrame(frame(255))).toEqual({ accepted: true, reason: "ACCEPTED" });
    const occurrence = f.store.read().vehicleRules[ruleId]!.startedAt;
    expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 80, bioMode: "force-on" });
    f.advance(hold * 1000 - 1000); await f.input.injectFrame(frame(0));
    expect(f.store.read().vehicleRules[ruleId]!.startedAt).toBe(occurrence);
    f.advance(hold * 1000 - 1); await f.runtime.tick(); expect(f.writes).toHaveLength(1);
    f.advance(1); await f.runtime.tick();
    expect(f.writes).toEqual([
      { fixtureId: b, configuration: { configuredHighBrightnessPercent: 80, bioMode: "force-on" } },
      { fixtureId: b, configuration: { configuredHighBrightnessPercent: 30, bioMode: "sensor" } }
    ]);
    const records = await f.outbox.pending();
    expect(records.map(record => record.event.kind)).toEqual(expect.arrayContaining(["event_started", "event_extended", "event_ended", "action_result"]));
    expect(f.store.read().pendingTelemetryHandoffs).toEqual([]);
    const wire = JSON.stringify(records.map(record => record.event));
    for (const sensitive of ["001122334455", "001122334466", "aabb", "nativeUuid", "innerBody"]) expect(wire).not.toContain(sensitive);
  });

  it("rejects invalid CRC, alive, wrong body, unqualified health and the production allowlist before occurrence/RF", async () => {
    const f = await fixture();
    const corrupt = frame(1); corrupt[corrupt.length - 1]! ^= 0xff;
    for (const bytes of [corrupt, frame(1, 0x0c), frame(1, 0x09, "aabc"), Buffer.concat([frame(1), frame(2).subarray(0, 5)])]) {
      expect((await f.input.injectFrame(bytes)).accepted).toBe(false);
    }
    f.authority.independentlyQualified = false;
    expect((await f.input.injectFrame(frame(1))).reason).toBe("LINK_UNHEALTHY");
    f.authority.independentlyQualified = true;
    const productProfiles = createSoftwareBioPulseInput({ ...f.inputOptions, profiles: BIO_SENSOR_PULSE_PROFILES })!;
    expect(await productProfiles.injectFrame(frame(1))).toEqual({ accepted: false, reason: "PROFILE_NOT_APPROVED" });
    expect(f.store.read().bioPulseInbox).toEqual({}); expect(f.writes).toEqual([]);
    expect(createSoftwareBioPulseInput({ ...f.inputOptions, nodeEnv: "development" })).toBeNull();
    expect(() => createSoftwareBioPulseInput({ ...f.inputOptions, nodeEnv: "production" })).toThrow("forbidden in production");
  });

  it("retains B on degraded/restart and requires an entire recovered healthy window", async () => {
    const f = await fixture(); await f.input.injectFrame(frame(1)); f.advance(5000);
    f.authority.observation.health = "degraded";
    f.authority.observation.reason = "usb_disconnected";
    await f.runtime.setBioSourceHealth(a, "degraded", "usb_disconnected");
    f.advance(60000); await f.runtime.tick(); expect(f.writes).toHaveLength(1);
    const restarted = await f.make();
    expect((await restarted.input.injectFrame(frame(2))).accepted).toBe(false);
    f.authority.observation.health = "healthy"; f.authority.observation.healthySinceMonotonicMs = 66000;
    await restarted.runtime.setBioSourceHealth(a, "healthy", "qualified");
    f.advance(9999); await restarted.runtime.tick(); expect(f.writes).toHaveLength(1);
    f.advance(1); await restarted.runtime.tick(); expect(f.configuration().bioMode).toBe("sensor");
    const records = (await f.outbox.pending()).map(record => record.event);
    expect(records.every(event => event.schemaVersion === 2)).toBe(true);
    expect(records.filter(event => event.kind === "event_extended").map(event => event.payload.reason)).toEqual([
      "bio_source_degraded", "bio_health_recovered", "bio_release_pending"
    ]);
    expect(records.at(-1)?.kind).toBe("event_ended");
  });

  it("rejects malformed BIO evidence before journal mutation and allows the next valid handoff", async () => {
    const f = await fixture(); const before = f.store.read();
    await expect(f.store.updateDurable(state => {
      const handoff = f.store.createTelemetryHandoff([{ revision: 4, ruleId, occurrenceKey: "synthetic", kind: "action_result",
        occurredAt: new Date().toISOString(), payload: { sensorProtocol: "bio-usb-pulse", nativeUuid: "001122334455" } }]);
      state.pendingTelemetryHandoffs.push(handoff!); return state;
    })).rejects.toThrow();
    expect(f.store.read()).toEqual(before);
    await f.input.injectFrame(frame(1));
    expect((await f.outbox.pending()).map(record => record.event.kind)).toEqual(["vehicle_detected", "event_started", "action_result"]);
    expect(f.store.read().pendingTelemetryHandoffs).toEqual([]);
  });

  it("keeps durable redacted telemetry while disconnected and retransmits exact identities until application ACK", async () => {
    const f = await fixture();
    const publisher = new AutomationTelemetryPublisher(f.outbox, scope, { retryInitialDelayMs: 60000 });
    cleanup.push(() => publisher.stopAndDrain());
    publisher.disconnect(); await f.input.injectFrame(frame(1)); f.advance(5000); await f.input.injectFrame(frame(2));
    f.authority.observation.health = "degraded"; f.authority.observation.reason = "usb_disconnected";
    await f.runtime.setBioSourceHealth(a, "degraded", "usb_disconnected");
    f.advance(60000); const restarted = await f.make();
    f.authority.observation.health = "healthy"; f.authority.observation.healthySinceMonotonicMs = 66000;
    await restarted.runtime.setBioSourceHealth(a, "healthy", "qualified");
    f.advance(10000); await restarted.runtime.tick(); await publisher.wake();
    const pending = await f.outbox.pending(); expect(pending.length).toBeGreaterThan(0);
    expect(pending.map(({ event }) => event.kind)).toEqual([
      "vehicle_detected", "event_started", "action_result", "vehicle_detected", "event_extended",
      "event_extended", "event_extended", "event_extended", "action_result", "event_ended"
    ]);
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([l], [r]) => l.localeCompare(r)).map(([key, child]) => [key, canonical(child)])) : value;
    pending.forEach((record, index) => {
      expect(record.event.sequence).toBe(index + 1);
      expect(record.reportPayloadHash).toBe(`sha256:${createHash("sha256").update(JSON.stringify(canonical(record.event))).digest("hex")}`);
    });
    const delivered: Array<{ topic: string; event: unknown }> = [];
    const transport = { publish(topic: string, body: string | Buffer, _options: unknown, callback: (error?: Error) => void) {
      delivered.push({ topic, event: JSON.parse(body.toString()) }); callback();
    } };
    await publisher.connect(transport);
    expect(delivered).toEqual(pending.map(({ event }) => ({ topic: mqttTopics.automationExecution(a, b), event })));
    expect(await f.outbox.pending()).toHaveLength(pending.length); // Broker PUBACK is not API ingestion.
    publisher.disconnect();
    await publisher.stopAndDrain();
    const recovered = new AutomationTelemetryOutbox(f.outboxPath, scope, { headroomBytes: 16384 });
    await recovered.initialize();
    expect((await recovered.pending()).map(({ event }) => event)).toEqual(pending.map(({ event }) => event));
    const recoveredPublisher = new AutomationTelemetryPublisher(recovered, scope, { retryInitialDelayMs: 60000 });
    cleanup.push(() => recoveredPublisher.stopAndDrain());
    await recoveredPublisher.connect(transport);
    expect(delivered.slice(pending.length)).toEqual(delivered.slice(0, pending.length));
    expect(await recovered.markIngested({ eventId: pending[0]!.event.eventId, sequence: pending[0]!.event.sequence,
      reportPayloadHash: `sha256:${"0".repeat(64)}` })).toBe("conflict");
    for (const record of pending) await recovered.markIngested({ eventId: record.event.eventId, sequence: record.event.sequence,
      reportPayloadHash: record.reportPayloadHash });
    expect(await recovered.pending()).toEqual([]);
  });
});
