import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { StartTemporaryControlCommand, EndTemporaryControlCommand, TemporaryControlResult } from "@led-control/shared";
import { bioEnvelopeHash } from "../bio/bio-sensor-profile-catalog";
import { writeJsonAtomic } from "../mesh/mesh-store-file";
import { FileAutomationStateStore, parseAutomationState } from "./automation-state-store";
import type { BioConfigurationState, BioOperationControl, BioVerifiedLampTarget } from "../bio/bio-dongle-client";
import { BioTemporaryControlRuntime } from "./bio-temporary-control-runtime";
import { TemporaryControlMqtt } from "./temporary-control-mqtt";
import { TemporaryControlResultOutbox } from "./temporary-control-result-outbox";

function deliveryFor<T extends { startedAt?: string; endsAt: string }>(command: T) {
  const generatedAt = Date.parse(command.startedAt ?? command.endsAt);
  return { generatedAt, expiresAt: Math.min(generatedAt + 10_000, Date.parse(command.endsAt)) };
}

const fixtureId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const dirs: string[] = [];
function endCommand(command: StartTemporaryControlCommand): EndTemporaryControlCommand {
  const { brightness: _brightness, startedAt: _startedAt, payloadHash, ...base } = command;
  const payload = { ...base, kind: "end" as const, sessionRevision: 2 as const,
    originCommandHash: payloadHash, originSequence: command.sequence };
  return { ...payload, payloadHash: bioEnvelopeHash(payload) };
}
function rehashResult(result: TemporaryControlResult): TemporaryControlResult {
  const { resultHash: _hash, ...payload } = result;
  return { ...payload, resultHash: bioEnvelopeHash(payload) };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
type Control = BioOperationControl & { beforeMutation(stage: "high_brightness" | "mode"): Promise<void> };

async function harness(brightness = 80, minutes = 1) {
  const dir = await mkdtemp(join(tmpdir(), "bio-temporary-")); dirs.push(dir);
  const path = join(dir, "state.json");
  let nowMs = Date.parse("2026-10-14T00:00:00.000Z");
  let trusted = true;
  let denied = false;
  let monotonicMs = 0;
  let onClock: () => void = () => {};
  let onPreflight: () => Promise<void> = async () => {};
  let onNative: () => void = () => {};
  let failStore: (value: any) => boolean = () => false;
  let afterStore: (value: any) => void = () => {};
  const writer = async (file: string, value: unknown) => {
    if (failStore(value)) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    await writeJsonAtomic(file, value);
    afterStore(value);
  };
  const store = new FileAutomationStateStore(path, writer); await store.initialize();
  await store.updateDurable(state => { state.baseBrightnessByFixture[fixtureId] = 30; return state; });
  const payload = { schemaVersion: 1 as const, kind: "start" as const, sessionId, sessionRevision: 1 as const,
    siteId: "00000000-0000-4000-8000-000000000003", gatewayId: "00000000-0000-4000-8000-000000000004",
    assignmentVersion: 1, admissionRevision: 7, sequence: 9, brightness,
    startedAt: new Date(nowMs).toISOString(), endsAt: new Date(nowMs + minutes * 60_000).toISOString(),
    targets: [{ fixtureId, meshNodeId: fixtureId, nativeUuid: "001122334455", logicalAddress: "0x0001",
      applyGeneration: "9007199254740993", releaseGeneration: "9007199254740994" }] };
  const command: StartTemporaryControlCommand = { ...payload, payloadHash: bioEnvelopeHash(payload) };
  const target: BioVerifiedLampTarget = { kind: "unicast", nativeUuid: "001122334455", logicalAddress: 1, networkId: 2 };
  let configuration: BioConfigurationState = { configuredHighBrightnessPercent: 30, bioMode: "sensor" };
  let failure: "high" | "mode" | "mode-only" | "unknown" | "before" | null = null;
  let afterRead: (() => void) | undefined;
  const writes: string[] = [];
  let reads = 0;
  const port = {
    async read(_id: string, control: BioOperationControl) {
      await control.beforeWrite?.(); reads++;
      if (failure === "unknown" && writes.length) throw new Error("GET unknown");
      const result = structuredClone({ target, configuration }); afterRead?.(); return result;
    },
    async apply(_id: string, level: number, control: Control) {
      if (failure === "before") throw new Error("no submission");
      for (const stage of level === 0 ? ["mode"] as const : ["high_brightness", "mode"] as const) {
        await control.beforeMutation(stage); await control.beforeWrite?.();
        onNative();
        if (control.mayStartWrite?.() === false) throw new Error("veto");
        const durable = JSON.parse(await readFile(path, "utf8"));
        expect(durable.temporarySessions[sessionId].targets[fixtureId].preState)
          .toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
        expect(durable.temporarySessions[sessionId].targets[fixtureId].configurationMayHaveChanged).toBe(true);
        control.onWriteStarted?.(); writes.push(stage);
        if (stage === "high_brightness") { if (failure !== "mode-only") configuration.configuredHighBrightnessPercent = level; }
        else if (failure !== "mode") configuration.bioMode = level ? "force-on" : "force-off";
        if (failure === "high" || failure === "unknown") throw new Error("partial write");
      }
      return { brightnessPercent: level, mode: level ? "force-on" as const : "force-off" as const };
    },
    async restore() { throw new Error("Task7 owns latest restoration"); }
  };
  const create = (nextStore = store) => new BioTemporaryControlRuntime({ store: nextStore, port,
    clockTrust: { isTrusted: async () => { onClock(); return trusted; } }, now: () => new Date(nowMs), monotonic: () => monotonicMs,
    preflight: async () => { await onPreflight(); if (denied) throw new Error("bio_source_target_forbidden"); } });
  const runtime = create();
  return { store, runtime, command, writes, create, path, target, port,
    row: () => (store.read() as any).temporarySessions[sessionId]?.targets[fixtureId],
    session: () => (store.read() as any).temporarySessions[sessionId],
    lease: () => (store.read() as any).fixtureLeases[fixtureId],
    configuration: () => structuredClone(configuration), reads: () => reads,
    fail: (value: typeof failure) => { failure = value; }, deny: () => { denied = true; },
    trust: (value: boolean) => { trusted = value; }, advance: (ms: number) => { nowMs += ms; },
    failStore: (value: typeof failStore) => { failStore = value; }, afterRead: (value: () => void) => { afterRead = value; },
    afterStore: (value: typeof afterStore) => { afterStore = value; },
    now: () => new Date(nowMs), monotonicAdvance: (ms: number) => { monotonicMs += ms; },
    onClock: (value: typeof onClock) => { onClock = value; },
    onPreflight: (value: typeof onPreflight) => { onPreflight = value; },
    onNative: (value: typeof onNative) => { onNative = value; } };
}

// Break caught: accepting at ingress must not authorize a later SET once its
// delivery budget, clock-skew reserve, or same-boot session deadline is gone.
it.each(["clock", "preflight", "fsync", "native", "skew", "monotonic", "clock-age", "wall-skew", "queue"])("delivery authority vetoes stale first SET after %s", async boundary => {
  const h = await harness();
  const authority = { generatedAt: h.now().getTime(), expiresAt: h.now().getTime() + 10_000 };
  let delayed = false;
  const delay = () => { if (!delayed) { delayed = true; h.advance(boundary === "skew" ? 8_000 : 10_000); } };
  if (boundary === "clock") h.onClock(delay);
  if (boundary === "preflight") h.onPreflight(async () => { delay(); });
  if (boundary === "fsync") h.afterStore(value => { if (value.temporarySessions?.[sessionId]?.targets[fixtureId]?.preState) delay(); });
  if (boundary === "native" || boundary === "skew") h.onNative(delay);
  if (boundary === "monotonic") h.onNative(() => { h.monotonicAdvance(60_000); });
  if (boundary === "clock-age") h.onNative(() => { h.advance(3_000); h.monotonicAdvance(3_000); });
  if (boundary === "wall-skew") h.onNative(() => { h.advance(2_000); });
  let unblock: (() => void) | undefined;
  let queueBarrier: Promise<void> | undefined;
  if (boundary === "queue") {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    queueBarrier = h.runtime.withReceiptSettlement(async () => { entered(); await new Promise<void>(resolve => { unblock = resolve; }); });
    await ready;
  }
  const operation = h.runtime.accept(h.command, authority);
  if (boundary === "queue") { delay(); unblock!(); await queueBarrier; }
  await operation;
  expect(h.writes).toEqual([]);
  expect(h.session().command.endsAt).toBe("2026-10-14T00:01:00.000Z");
  expect(h.row()).toMatchObject({ configurationMayHaveChanged: false, applyResult: { rfWriteEvidence: "not_started" } });
});

it("MQTT clock await carries the original delivery expiry into the real runtime", async () => {
  const h = await harness();
  const mqtt = new TemporaryControlMqtt({ scope: h.command, runtime: h.runtime,
    outbox: new TemporaryControlResultOutbox(h.store, h.command), now: h.now,
    clockTrust: { isTrusted: async () => { h.advance(10_000); return true; } } });
  const envelope = { ...h.command, deliveryGeneration: "00000000-0000-4000-8000-000000000055",
    deliveryGeneratedAt: h.command.startedAt, deliveryWindowMs: 10_000, expiresAt: "2026-10-14T00:00:10.000Z" };
  try {
    await mqtt.handleCommand(Buffer.from(JSON.stringify({ ...envelope, deliveryPayloadHash: bioEnvelopeHash(envelope) })));
    expect(h.writes).toEqual([]);
    expect(h.row().applyResult.rfWriteEvidence).toBe("not_started");
  } finally { await mqtt.stopAndDrain(); }
});

it("requires start authority and a fresh duplicate delivery never extends session timing", async () => {
  const h = await harness();
  await expect(h.runtime.accept(h.command)).rejects.toThrow("temporary_delivery_authority_required");
  await h.runtime.accept(h.command, deliveryFor(h.command));
  h.advance(5_000);
  await h.runtime.accept(h.command, { generatedAt: h.now().getTime(), expiresAt: h.now().getTime() + 10_000 });
  expect(h.writes).toEqual(["high_brightness", "mode"]);
  expect(h.session().command).toEqual(h.command);
  expect(h.session().command.endsAt).toBe("2026-10-14T00:01:00.000Z");
});

it("a slow preceding target cannot authorize the next target outside the delivery window", async () => {
  const h = await harness();
  const secondId = "00000000-0000-4000-8000-000000000006";
  const { payloadHash: _hash, ...body } = h.command;
  const payload = { ...body, targets: [...body.targets, { ...body.targets[0]!, fixtureId: secondId, meshNodeId: secondId,
    nativeUuid: "001122334466", logicalAddress: "0x0002" }] };
  const command = { ...payload, payloadHash: bioEnvelopeHash(payload) };
  const writes: string[] = [];
  const configurations = new Map(command.targets.map(target => [target.fixtureId,
    { configuredHighBrightnessPercent: 30, bioMode: "sensor" as const } as BioConfigurationState]));
  const runtime = new BioTemporaryControlRuntime({ store: h.store, now: h.now, monotonic: () => 0,
    clockTrust: { isTrusted: async () => true }, preflight: async () => {}, port: {
      read: async (id, control) => { await control.beforeWrite?.(); const snapshot = command.targets.find(row => row.fixtureId === id)!;
        return { target: { kind: "unicast", nativeUuid: snapshot.nativeUuid, logicalAddress: id === fixtureId ? 1 : 2, networkId: 2 },
          configuration: { ...configurations.get(id)! } }; },
      apply: async (id, brightness, control) => {
        await control.beforeMutation("high_brightness"); await control.beforeWrite?.();
        if (!control.mayStartWrite?.()) throw new Error("veto");
        control.onWriteStarted?.(); writes.push(id);
        configurations.set(id, { configuredHighBrightnessPercent: brightness, bioMode: "force-on" });
        h.advance(10_000); return { brightnessPercent: brightness, mode: "force-on" };
      }, restore: async () => { throw new Error("unexpected restoration"); }
    } });
  await runtime.accept(command, deliveryFor(command));
  expect(writes).toEqual([fixtureId]);
  expect(h.store.read().temporarySessions[sessionId]!.targets[secondId]!.applyResult?.rfWriteEvidence).toBe("not_started");
  expect(h.store.read().temporarySessions[sessionId]!.targets[fixtureId]!.configurationMayHaveChanged).toBe(true);
});

it("delivery expiry between native stages preserves the prior high-write uncertainty for release", async () => {
  const h = await harness(); h.onNative(() => { if (h.writes.length) h.advance(10_000); });
  await h.runtime.accept(h.command, deliveryFor(h.command));
  expect(h.writes).toEqual(["high_brightness"]);
  expect(h.row()).toMatchObject({ applyConfirmed: false, configurationMayHaveChanged: true, partialMutation: "high_brightness" });
  expect(h.runtime.ownsFixture(fixtureId)).toBe(true);
  const { brightness: _brightness, startedAt: _startedAt, payloadHash, ...base } = h.command;
  const body = { ...base, kind: "end" as const, sessionRevision: 2 as const, originCommandHash: payloadHash, originSequence: h.command.sequence };
  await h.runtime.accept({ ...body, payloadHash: bioEnvelopeHash(body) });
  expect(h.session().sessionRevision).toBe(2);
  expect(h.runtime.ownsFixture(fixtureId)).toBe(true);
});

it("partial_high_write_never_becomes_unchanged_or_baseline", async () => {
  const h = await harness(); h.fail("high"); await h.runtime.accept(h.command, deliveryFor(h.command));
  expect(h.row()).toMatchObject({ applyConfirmed: false, configurationMayHaveChanged: true, partialMutation: "high_brightness" });
  expect(h.lease().sessionId).toBe(sessionId);
  expect(h.store.read().baseBrightnessByFixture).toEqual({ [fixtureId]: 30 });
  expect(h.store.read().manualAutomationSuppressions).toEqual({});
});
it.each([0, 80])("confirms %i only from complete independent GET and preserves absolute expiry on duplicate", async level => {
  const h = await harness(level); await h.runtime.accept(h.command, deliveryFor(h.command)); await h.runtime.accept(h.command, deliveryFor(h.command));
  expect(h.row()).toMatchObject({ applyConfirmed: true, configurationMayHaveChanged: true, partialMutation: "none" });
  expect(h.session().state).toBe("holding"); expect(h.writes).toEqual(level ? ["high_brightness", "mode"] : ["mode"]);
  expect(h.session().command.endsAt).toBe("2026-10-14T00:01:00.000Z");
  expect(Object.values((h.store.read() as any).temporaryResultOutbox)).toHaveLength(1);
});
it("keeps high-only mode mismatch and unknown distinct", async () => {
  const h = await harness(); h.fail("mode"); await h.runtime.accept(h.command, deliveryFor(h.command));
  expect(h.row()).toMatchObject({ applyConfirmed: false, partialMutation: "high_brightness" });
  const unknown = await harness(); unknown.fail("unknown"); await unknown.runtime.accept(unknown.command, deliveryFor(unknown.command));
  expect(unknown.row()).toMatchObject({ configurationMayHaveChanged: true, partialMutation: "unverified" });
  expect(unknown.session().state).toBe("unknown"); expect(unknown.runtime.ownsFixture(fixtureId)).toBe(true);
  await unknown.runtime.observe(fixtureId, { target: unknown.target, configuration: unknown.configuration() });
  expect(unknown.row().partialMutation).toBe("high_brightness");
  expect(unknown.runtime.ownsFixture(fixtureId)).toBe(true);
  const mode = await harness(); mode.fail("mode-only"); await mode.runtime.accept(mode.command, deliveryFor(mode.command));
  expect(mode.row()).toMatchObject({ applyConfirmed: false, configurationMayHaveChanged: true, partialMutation: "mode" });
});
it("RF-before failure proves unchanged without inventing a successful apply", async () => {
  const h = await harness(); h.fail("before"); await h.runtime.accept(h.command, deliveryFor(h.command));
  expect(h.writes).toEqual([]); expect(h.row()).toMatchObject({ applyConfirmed: false, configurationMayHaveChanged: false, partialMutation: "none" });
  expect(h.row().applyResult.rfWriteEvidence).toBe("not_started");
  expect(h.session().state).toBe("rejected"); expect(h.runtime.ownsFixture(fixtureId)).toBe(false);
});
it.each([1, 1440])("expires %i minute immutable sessions with the reserved release generation", async minutes => {
  const h = await harness(80, minutes); await h.runtime.accept(h.command, deliveryFor(h.command)); h.advance(minutes * 60_000);
  h.trust(false); await h.runtime.tick();
  expect(h.session()).toMatchObject({ sessionRevision: 2, state: "releasing" });
  expect(h.lease()).toMatchObject({ sessionId, lastGeneration: "9007199254740994", phase: "releasing" });
  expect(h.runtime.ownsFixture(fixtureId)).toBe(true); expect(h.writes).toHaveLength(2);
});
it("never reapplies expired or restarted pending mutation and preserves sticky unknown", async () => {
  const h = await harness(); h.failStore(value => Boolean(value.temporarySessions?.[sessionId]?.targets[fixtureId]?.applyResult));
  await expect(h.runtime.accept(h.command, deliveryFor(h.command))).rejects.toThrow();
  const restarted = new FileAutomationStateStore(h.path); await restarted.initialize();
  h.fail("unknown"); const runtime = h.create(restarted); await runtime.accept(h.command, deliveryFor(h.command));
  expect(h.writes).toHaveLength(2); expect(runtime.ownsFixture(fixtureId)).toBe(true);
  expect((restarted.read() as any).temporarySessions[sessionId].state).toBe("unknown");
});
it("blocks active source/current identity revocation after GET and clock rollback before mutation", async () => {
  const h = await harness(); h.afterRead(h.deny); await h.runtime.accept(h.command, deliveryFor(h.command));
  expect(h.writes).toEqual([]);
  const clock = await harness(); clock.afterRead(() => { clock.advance(-600_000); clock.trust(false); });
  await clock.runtime.accept(clock.command, deliveryFor(clock.command)); expect(clock.writes).toEqual([]);
});
it("blocks mismatched GET UUID/address even when the current preflight passed", async () => {
  const h = await harness(); h.target.nativeUuid = "aabbccddeeff"; await h.runtime.accept(h.command, deliveryFor(h.command));
  expect(h.writes).toEqual([]); expect(h.row().applyConfirmed).toBe(false);
});
it("ENOSPC intent cannot start RF or erase a prior partial mutation", async () => {
  const h = await harness(); h.failStore(value => Boolean(value.temporarySessions?.[sessionId]?.targets[fixtureId]?.configurationMayHaveChanged));
  await expect(h.runtime.accept(h.command, deliveryFor(h.command))).rejects.toThrow(); expect(h.writes).toEqual([]);
  const partial = await harness();
  partial.failStore(value => value.temporarySessions?.[sessionId]?.targets[fixtureId]?.partialMutation === "unverified" && partial.writes.length > 0);
  await expect(partial.runtime.accept(partial.command, deliveryFor(partial.command))).rejects.toThrow();
  expect(partial.writes).toEqual(["high_brightness"]);
  expect(partial.row().configurationMayHaveChanged).toBe(true); expect(partial.runtime.ownsFixture(fixtureId)).toBe(true);
});
it("persists end-before-start tombstone and lease across restart without fabricating a start or RF proof", async () => {
  const h = await harness(); const end = endCommand(h.command);
  await h.runtime.accept(end, deliveryFor(end)); await h.runtime.accept(end, deliveryFor(end));
  expect((h.store.read() as any).temporaryEndTombstones[sessionId]).toEqual(end);
  expect(h.session()).toBeUndefined(); expect(h.runtime.ownsFixture(fixtureId)).toBe(true);
  const restarted = new FileAutomationStateStore(h.path); await restarted.initialize();
  const runtime = h.create(restarted); await runtime.accept(h.command, deliveryFor(h.command)); await runtime.tick();
  expect(h.writes).toEqual([]);
  expect((restarted.read() as any).temporarySessions[sessionId]).toMatchObject({ sessionRevision: 2, state: "releasing", command: h.command });
  expect((restarted.read() as any).temporaryResultOutbox).toEqual({});
});
it("rejects forged end origin and newer owner conflicts without overwriting existing ownership", async () => {
  const h = await harness(); await h.runtime.accept(h.command, deliveryFor(h.command));
  const end = endCommand(h.command); const { payloadHash: _hash, ...payload } = { ...end, originSequence: 99 };
  await expect(h.runtime.accept({ ...payload, payloadHash: bioEnvelopeHash(payload) }, deliveryFor({ ...payload, payloadHash: bioEnvelopeHash(payload) }))).rejects.toThrow();
  expect(h.lease()).toMatchObject({ sessionId, lastGeneration: "9007199254740993" });
  const { payloadHash: _startHash, ...next } = { ...h.command, sessionId: "00000000-0000-4000-8000-000000000099" };
  const other = { ...next, payloadHash: bioEnvelopeHash(next) };
  await expect(h.runtime.accept(endCommand(other), deliveryFor(endCommand(other)))).rejects.toThrow();
  expect(h.lease().sessionId).toBe(sessionId);
});
it("proves RF0 when current authority vetoes the first prepared write before submission", async () => {
  const h = await harness();
  h.afterStore(value => { if (value.temporarySessions?.[sessionId]?.targets[fixtureId]?.configurationMayHaveChanged) h.deny(); });
  await h.runtime.accept(h.command, deliveryFor(h.command));
  expect(h.writes).toEqual([]);
  expect(h.row()).toMatchObject({ configurationMayHaveChanged: false, partialMutation: "none",
    applyResult: { rfWriteEvidence: "not_started" } });
  expect(h.runtime.ownsFixture(fixtureId)).toBe(false);
});
it("accepts end for its already RF0-settled start without resurrecting ownership", async () => {
  const h = await harness(); h.fail("before"); await h.runtime.accept(h.command, deliveryFor(h.command));
  await h.runtime.accept(endCommand(h.command), deliveryFor(endCommand(h.command))); await h.runtime.accept(endCommand(h.command), deliveryFor(endCommand(h.command)));
  expect(h.runtime.ownsFixture(fixtureId)).toBe(false); expect(h.writes).toEqual([]);
});
it("strict persisted evidence rejects removed owner, altered command hash, and foreign generation", async () => {
  const h = await harness(); await h.runtime.accept(h.command, deliveryFor(h.command));
  for (const mutate of [
    (state: any) => { state.fixtureLeases[fixtureId].sessionId = null; },
    (state: any) => { state.temporarySessions[sessionId].command.brightness = 20; },
    (state: any) => {
      const result = state.temporarySessions[sessionId].targets[fixtureId].applyResult;
      result.targetGeneration = "99"; const { resultHash: _hash, ...payload } = result;
      result.resultHash = bioEnvelopeHash(payload);
    }
  ]) { const value = h.store.read(); mutate(value); expect(() => parseAutomationState(value)).toThrow(); }
});
it("fences the reserved release generation even after an RF0 apply settled", async () => {
  const h = await harness(); h.fail("before"); await h.runtime.accept(h.command, deliveryFor(h.command));
  const { payloadHash: _hash, ...payload } = { ...h.command, sessionId: "00000000-0000-4000-8000-000000000099",
    targets: [{ ...h.command.targets[0]!, applyGeneration: "9007199254740994", releaseGeneration: "9007199254740995" }] };
  await expect(h.runtime.accept({ ...payload, payloadHash: bioEnvelopeHash(payload) }, deliveryFor({ ...payload, payloadHash: bioEnvelopeHash(payload) }))).rejects.toThrow("temporary_fixture_lease_conflict");
  expect(h.writes).toEqual([]);
  const successorPayload = { ...payload, targets: [{ ...payload.targets[0]!,
    applyGeneration: "9007199254740995", releaseGeneration: "9007199254740996" }] };
  const successor = { ...successorPayload, payloadHash: bioEnvelopeHash(successorPayload) };
  await h.runtime.accept(endCommand(successor), deliveryFor(endCommand(successor)));
  expect(h.lease()).toMatchObject({ sessionId: successor.sessionId, lastGeneration: "9007199254740996", phase: "releasing" });
});

it.each(["missing", "cleared_without_proof", "regressed"] as const)("rejects end-only tombstone with %s safety reservation", async invalid => {
  const h = await harness(); await h.runtime.accept(endCommand(h.command), deliveryFor(endCommand(h.command)));
  const state = h.store.read(); const lease = state.fixtureLeases[fixtureId]!;
  if (invalid === "missing") delete state.fixtureLeases[fixtureId];
  else {
    lease.sessionId = null; lease.phase = "restored";
    if (invalid === "regressed") {
      lease.identity.applyGeneration = "1"; lease.identity.releaseGeneration = "2";
      lease.applyGeneration = "1"; lease.releaseGeneration = "2"; lease.lastGeneration = "2";
    }
  }
  expect(() => parseAutomationState(state)).toThrow();
});

it("retains an old end-only tombstone when a strictly newer non-overlapping fence is preserved", async () => {
  const h = await harness(); await h.runtime.accept(endCommand(h.command), deliveryFor(endCommand(h.command)));
  const state = h.store.read(); const lease = state.fixtureLeases[fixtureId]!;
  lease.sessionId = null; lease.phase = "restored";
  lease.identity.applyGeneration = "9007199254740995"; lease.identity.releaseGeneration = "9007199254740996";
  lease.applyGeneration = "9007199254740995"; lease.releaseGeneration = "9007199254740996"; lease.lastGeneration = "9007199254740996";
  expect(parseAutomationState(state).temporaryEndTombstones).toEqual(state.temporaryEndTombstones);
});

it.each(["apply_slot", "release_slot", "future_outbox"] as const)("rejects validly hashed temporary evidence in %s", async invalid => {
  const h = await harness(); await h.runtime.accept(h.command, deliveryFor(h.command));
  if (invalid !== "future_outbox") await h.runtime.accept(endCommand(h.command), deliveryFor(endCommand(h.command)));
  const state = h.store.read(); const target = state.temporarySessions[sessionId]!.targets[fixtureId]!;
  if (invalid === "release_slot") {
    target.releaseResult = rehashResult({ ...target.applyResult!, kind: "observation", applyConfirmed: false });
  } else {
    const future = rehashResult({ ...target.applyResult!, kind: "observation", sessionRevision: 2,
      targetGeneration: target.snapshot.releaseGeneration });
    if (invalid === "apply_slot") target.applyResult = future;
    else state.temporaryResultOutbox[future.eventId] = future;
  }
  expect(() => parseAutomationState(state)).toThrow();
});

it("rejects future release-slot evidence while its owner is still revision1", async () => {
  const h = await harness(); await h.runtime.accept(h.command, deliveryFor(h.command));
  const state = h.store.read(); const target = state.temporarySessions[sessionId]!.targets[fixtureId]!;
  target.releaseResult = rehashResult({ ...target.applyResult!, kind: "observation", sessionRevision: 2,
    applyConfirmed: false, targetGeneration: target.snapshot.releaseGeneration });
  expect(() => parseAutomationState(state)).toThrow();
});

it.each([
  { brightness: 80, high: 10, mode: "force-on" as const },
  { brightness: 80, high: 80, mode: "sensor" as const },
  { brightness: 0, high: 0, mode: "force-off" as const },
  { brightness: 0, high: 30, mode: "force-on" as const }
])("rejects holding confirmation mismatching requested $brightness with $high/$mode", async ({ brightness, high, mode }) => {
  const h = await harness(brightness); await h.runtime.accept(h.command, deliveryFor(h.command));
  const state = h.store.read(); const target = state.temporarySessions[sessionId]!.targets[fixtureId]!;
  target.applyResult = rehashResult({ ...target.applyResult!, configurationReadback: {
    configuredHighBrightnessPercent: high, bioMode: mode } });
  expect(() => parseAutomationState(state)).toThrow();
});
