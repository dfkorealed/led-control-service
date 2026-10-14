import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AutomationSnapshotV3, EndTemporaryControlCommand, StartTemporaryControlCommand, TemporaryControlResult, TemporaryControlIngestedReceipt } from "@led-control/shared";
import { bioEnvelopeHash } from "../bio/bio-sensor-profile-catalog";
import { FileAutomationStateStore, parseAutomationState } from "./automation-state-store";
import { BioTemporaryControlRuntime, type BioTemporaryApplyControl } from "./bio-temporary-control-runtime";
import type { BioConfigurationState, BioOperationControl } from "../bio/bio-dongle-client";
import { writeJsonAtomic } from "../mesh/mesh-store-file";
import { TemporaryControlResultOutbox } from "./temporary-control-result-outbox";
import { resolveLatestBioAutomaticTarget } from "./bio-temporary-release";

const fixtureId = "00000000-0000-4000-8000-000000000001", sessionId = "00000000-0000-4000-8000-000000000002";
const siteId = "00000000-0000-4000-8000-000000000003", gatewayId = "00000000-0000-4000-8000-000000000004";
const scheduleId = "00000000-0000-4000-8000-000000000005";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function snapshot(revision = 7, brightnessPercent = 40): AutomationSnapshotV3 {
  const value = { schemaVersion: 3 as const, siteId, gatewayId, revision, timeZone: "Asia/Seoul", generatedAt: "2026-10-14T00:00:00Z",
    holidayDatasets: [], vehicleEventRules: [], schedules: [{ id: scheduleId, name: "Latest schedule", status: "enabled" as const,
      fixtureIds: [fixtureId], action: { dimmingEnabled: true, brightnessPercent }, activeFrom: "2026-10-01T00:00:00Z", activeUntil: "2026-12-31T00:00:00Z",
      localStartTime: "08:00", localEndTime: "18:00", recurrence: { kind: "daily" as const, weeklyDays: [], monthlyDay: null,
        yearlyMonth: null, yearlyDay: null }, excludeWeekends: false, excludeHolidays: false }] };
  return { ...value, payloadHash: bioEnvelopeHash(value) } as unknown as AutomationSnapshotV3;
}
async function harness(withNormalProof = true) {
  const dir = await mkdtemp(join(tmpdir(), "bio-release-")); directories.push(dir);
  const path = join(dir, "state.json"); let nowMs = Date.parse("2026-10-14T00:00:00Z"), mono = 1000;
  let current = snapshot(), denied = false, partial = false;
  let afterRead: (() => void) | undefined; let afterStore: ((value: any) => void) | undefined;
  let failStore: ((value: any) => boolean) | undefined;
  const store = new FileAutomationStateStore(path, async (file, value) => {
    if (failStore?.(value)) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    await writeJsonAtomic(file, value); afterStore?.(value);
  }); await store.initialize();
  const payload = { schemaVersion: 1 as const, kind: "start" as const, sessionId, sessionRevision: 1 as const,
    siteId, gatewayId, assignmentVersion: 1, admissionRevision: 7, sequence: 9, brightness: 80,
    startedAt: new Date(nowMs).toISOString(), endsAt: new Date(nowMs + 60_000).toISOString(),
    targets: [{ fixtureId, meshNodeId: fixtureId, nativeUuid: "001122334455", logicalAddress: "0x0001", applyGeneration: "1", releaseGeneration: "2" }] };
  const command: StartTemporaryControlCommand = { ...payload, payloadHash: bioEnvelopeHash(payload) };
  const { brightness: _brightness, startedAt: _startedAt, payloadHash, ...endBase } = command;
  const endBody = { ...endBase, kind: "end" as const, sessionRevision: 2 as const, originCommandHash: payloadHash, originSequence: command.sequence };
  const end: EndTemporaryControlCommand = { ...endBody, payloadHash: bioEnvelopeHash(endBody) };
  const target = { kind: "unicast" as const, nativeUuid: "001122334455", logicalAddress: 1, networkId: 2 };
  let configuration: BioConfigurationState = { configuredHighBrightnessPercent: 30, bioMode: "sensor" };
  if (withNormalProof) await store.updateDurable(state => {
    state.bioNormalConfigurations[fixtureId] = { identity: { fixtureId, meshNodeId: fixtureId, nativeUuid: target.nativeUuid, logicalAddress: "0x0001" },
      siteId, gatewayId, assignmentVersion: 1, networkId: 2, configuration: structuredClone(configuration), observedAt: payload.startedAt,
      baselineBrightness: null, snapshotRevision: 6, snapshotPayloadHash: bioEnvelopeHash({ priorNormal: true }) }; return state;
  });
  const writes: BioConfigurationState[] = []; let reads = 0;
  const port = {
    read: async (_id: string, control: BioOperationControl) => {
      await control.beforeWrite?.(); reads++; const value = structuredClone({ target, configuration }); afterRead?.(); return value;
    },
    apply: async (_id: string, brightness: number, control: BioTemporaryApplyControl) => {
      await control.beforeMutation("high_brightness"); await control.beforeWrite?.(); control.onWriteStarted?.();
      configuration.configuredHighBrightnessPercent = brightness;
      if (partial) throw new Error("mode did not write");
      await control.beforeMutation("mode"); await control.beforeWrite?.(); control.onWriteStarted?.(); configuration.bioMode = "force-on";
      return { brightnessPercent: brightness, mode: "force-on" as const };
    },
    restore: async (_id: string, _target: typeof target, value: BioConfigurationState, control: BioTemporaryApplyControl) => {
      for (const stage of ["high_brightness", "mode"] as const) {
        await control.beforeMutation(stage); await control.beforeWrite?.();
        if (control.mayStartWrite?.() === false) throw new Error("veto");
        expect(JSON.parse(await readFile(path, "utf8")).temporarySessions[sessionId].sessionRevision).toBe(2);
        control.onWriteStarted?.();
        if (stage === "high_brightness") configuration.configuredHighBrightnessPercent = value.configuredHighBrightnessPercent;
        else configuration.bioMode = value.bioMode;
      }
      writes.push(structuredClone(value)); return structuredClone(configuration);
    }
  };
  const create = (nextStore = store) => new BioTemporaryControlRuntime({ store: nextStore, port,
    clockTrust: { isTrusted: async () => true }, now: () => new Date(nowMs), monotonic: () => mono,
    snapshot: () => current,
    preflight: async () => { if (denied) throw new Error("source_health_unverified"); },
    releasePreflight: async () => { if (denied) throw new Error("source_health_unverified"); }
  } as any);
  const runtime = create();
  return { runtime, store, command, end, path, writes, create, target,
    outbox: () => new TemporaryControlResultOutbox(store, command, (result, state) => {
      const goal = resolveLatestBioAutomaticTarget({ fixtureId, snapshot: current, state, now: new Date(nowMs) });
      return !("reason" in goal) && goal.restorationRevision === result.restorationRevision && goal.restorationPayloadHash === result.restorationPayloadHash;
    }),
    row: () => store.read().temporarySessions[sessionId]?.targets[fixtureId],
    state: () => store.read().temporarySessions[sessionId]?.state,
    current: () => current, configuration: () => structuredClone(configuration), reads: () => reads,
    snapshot: (value: AutomationSnapshotV3) => { current = value; },
    normal: () => { const { payloadHash: _hash, ...value } = current; const body = { ...value, schedules: [] }; current = { ...body, payloadHash: bioEnvelopeHash(body) }; },
    revision: () => { current = snapshot(8, 55); }, deny: () => { denied = true; }, partial: () => { partial = true; },
    afterRead: (fn: () => void) => { afterRead = fn; }, afterStore: (fn: (value: any) => void) => { afterStore = fn; },
    failStore: (fn: (value: any) => boolean) => { failStore = fn; },
    advance: (ms: number) => { nowMs += ms; mono += ms; }, rollbackWall: () => { nowMs -= 60_000; }, now: () => new Date(nowMs) };
}
async function release(h: Awaited<ReturnType<typeof harness>>) {
  const runtime = h.runtime as any; expect(runtime.release).toBeTypeOf("function"); await runtime.release(h.end);
}

it("release_revision_race_and_degraded_release", async () => {
  const h = await harness(); await h.runtime.accept(h.command);
  h.afterRead(h.revision); await release(h);
  expect(h.row()?.releaseResult).toMatchObject({ releaseConfirmed: true, restorationRevision: 8, restorationPayloadHash: h.current().payloadHash });
  expect(h.configuration()).toEqual({ configuredHighBrightnessPercent: 55, bioMode: "force-on" });
  const degraded = await harness(); await degraded.runtime.accept(degraded.command);
  degraded.afterRead(degraded.deny); await release(degraded);
  expect(degraded.state()).toBe("recovery_pending"); expect(degraded.runtime.ownsFixture(fixtureId)).toBe(true);
  expect(degraded.writes).toEqual([]);
});
it("never reacquires an individually acknowledged target when End follows offline expiry", async () => {
  const h = await harness(); const other = "00000000-0000-4000-8000-000000000009";
  const { payloadHash: _hash, ...base } = h.command;
  const payload = { ...base, targets: [...base.targets, { ...base.targets[0]!, fixtureId: other, meshNodeId: other, nativeUuid: "001122334466", logicalAddress: "0x0002" }] };
  const command = { ...payload, payloadHash: bioEnvelopeHash(payload) };
  await h.runtime.accept(command); h.advance(60_000); await h.runtime.expire(h.now());
  const result = h.row()!.releaseResult!; await h.outbox().confirm(ack(result));
  expect(h.store.read().fixtureLeases[fixtureId]?.sessionId).toBeNull();
  expect(h.store.read().fixtureLeases[other]?.sessionId).toBe(sessionId);
  const { brightness: _b, startedAt: _s, payloadHash, ...endBase } = command;
  const endBody = { ...endBase, kind: "end" as const, sessionRevision: 2 as const, originCommandHash: payloadHash, originSequence: command.sequence };
  await h.runtime.release({ ...endBody, payloadHash: bioEnvelopeHash(endBody) });
  expect(h.store.read().fixtureLeases[fixtureId]?.sessionId).toBeNull();
  expect(h.row()?.releaseAcknowledged).toBe(true);
  expect(await h.outbox().confirm(ack(result))).toBe(false);
  await h.outbox().confirm(ack(h.store.read().temporarySessions[sessionId]!.targets[other]!.releaseResult!));
  expect(h.state()).toBe("restored");
  expect(parseAutomationState(h.store.read()).temporarySessions[sessionId]?.state).toBe("restored");
});
it("revalidates latest goal after durable pre-SET mutation intent without stale RF", async () => {
  const h = await harness(); await h.runtime.accept(h.command);
  h.afterStore(value => { if (value.temporarySessions[sessionId]?.sessionRevision === 2 &&
    value.temporarySessions[sessionId]?.targets[fixtureId]?.partialMutation === "high_brightness") h.revision(); });
  await release(h); expect(h.writes).toEqual([]); expect(h.state()).toBe("recovery_pending");
  await h.runtime.expire(h.now()); expect(h.row()?.releaseResult?.restorationRevision).toBe(8);
});
it("does not capture overlay configuration if no-overlay GET crosses a snapshot boundary", async () => {
  const h = await harness(false); h.normal(); h.afterRead(h.revision); await h.runtime.accept(h.command);
  expect(h.row()?.applyResult?.rfWriteEvidence).toBe("not_started"); expect(h.store.read().bioNormalConfigurations[fixtureId]).toBeUndefined();
});
it("offline holiday expiry excludes the schedule using the persisted verified dataset", async () => {
  const h = await harness(); await h.runtime.accept(h.command);
  const semantic = { country: "KR" as const, source: "kasi" as const, year: 2026, coverageFrom: "2026-01-01", coverageUntil: "2026-12-31",
    dates: [{ date: "2026-10-14", names: ["시험 공휴일"] }] };
  const { payloadHash: _hash, ...base } = h.current();
  const value = { ...base, revision: 8, schedules: base.schedules.map(rule => ({ ...rule, excludeHolidays: true })),
    holidayDatasets: [{ ...semantic, revision: "1", fetchedAt: "2026-10-01T00:00:00Z", payloadHash: bioEnvelopeHash(semantic) }] };
  h.snapshot({ ...value, payloadHash: bioEnvelopeHash(value) }); h.advance(60_000); await h.runtime.expire(h.now());
  expect(h.row()?.releaseResult).toMatchObject({ restorationRevision: 8, releaseConfirmed: true,
    configurationReadback: { configuredHighBrightnessPercent: 30, bioMode: "sensor" } });
});
function ack(result: TemporaryControlResult, status: "applied" | "rejected" = "applied"): TemporaryControlIngestedReceipt {
  const { schemaVersion, eventId, sessionId, siteId, gatewayId, assignmentVersion, admissionRevision, originCommandHash,
    originSequence, sessionRevision, targetGeneration, resultHash } = result;
  return { schemaVersion, eventId, sessionId, siteId, gatewayId, assignmentVersion, admissionRevision, originCommandHash,
    originSequence, sessionRevision, targetGeneration, resultHash, status,
    reason: status === "applied" ? null : "restoration_configuration_pending", ingestedAt: "2026-10-14T00:01:01Z" };
}
it("exact end-only receipt clears owner but retains strict RF0 proof/fence across restart and late start", async () => {
  const h = await harness(); await release(h); const result = Object.values(h.store.read().temporaryResultOutbox)[0]!;
  await h.outbox().confirm(ack(result));
  expect(h.runtime.ownsFixture(fixtureId)).toBe(false);
  expect(h.store.read().temporaryEndProofs[sessionId]?.[fixtureId]).toEqual(result);
  const invalid = h.store.read(); delete invalid.temporaryEndProofs[sessionId]; expect(() => parseAutomationState(invalid)).toThrow();
  const restarted = new FileAutomationStateStore(h.path); await restarted.initialize(); await h.create(restarted).accept(h.command);
  expect(restarted.read().fixtureLeases[fixtureId]?.sessionId).toBeNull(); expect(h.writes).toEqual([]);
});
it("rejected immutable release receipt renews fresh GET evidence and never replays old RF", async () => {
  const h = await harness(); await h.runtime.accept(h.command); await release(h); const first = h.row()!.releaseResult!;
  await h.outbox().confirm(ack(first, "rejected")); expect(h.runtime.ownsFixture(fixtureId)).toBe(true);
  const reads = h.reads(), writes = h.writes.length; await (h.runtime as any).expire(h.now());
  const renewed = h.row()!.releaseResult!;
  expect(renewed.eventId).not.toBe(first.eventId); expect(h.reads()).toBeGreaterThan(reads); expect(h.writes).toHaveLength(writes);
  expect(await h.outbox().confirm(ack(first))).toBe(false); expect(h.runtime.ownsFixture(fixtureId)).toBe(true);
  await h.outbox().confirm(ack(renewed)); expect(h.runtime.ownsFixture(fixtureId)).toBe(false); expect(h.state()).toBe("restored");
});
it("preserves pending restoration on terminal fsync failure then reconciles by GET after restart", async () => {
  const h = await harness(); await h.runtime.accept(h.command);
  h.failStore(value => !!value.temporarySessions[sessionId]?.targets[fixtureId]?.releaseConfirmed);
  await expect(release(h)).rejects.toThrow(); expect(h.runtime.ownsFixture(fixtureId)).toBe(true);
  const before = h.writes.length; const restarted = new FileAutomationStateStore(h.path); await restarted.initialize();
  await (h.create(restarted) as any).expire(h.now());
  expect(restarted.read().temporarySessions[sessionId]?.targets[fixtureId]?.releaseResult?.releaseConfirmed).toBe(true);
  expect(h.writes).toHaveLength(before);
});
it("uses same-boot monotonic expiry despite backward wall clock without extending immutable times", async () => {
  const h = await harness(); await h.runtime.accept(h.command); h.advance(60_000); h.rollbackWall();
  await (h.runtime as any).expire(h.now());
  expect(h.store.read().temporarySessions[sessionId]?.sessionRevision).toBe(2);
  expect(h.row()?.releaseResult?.targetGeneration).toBe("2");
});
it("anchors recovered original absolute expiry once to the new boot monotonic clock", async () => {
  const h = await harness(); await h.runtime.accept(h.command); const recovered = h.create();
  await recovered.expire(h.now()); h.advance(60_000); h.rollbackWall(); await recovered.expire(h.now());
  expect(h.store.read().temporarySessions[sessionId]?.sessionRevision).toBe(2);
});
it("rejects a new temporary write under overlay when independent normal configuration is missing", async () => {
  const h = await harness(false); await h.runtime.accept(h.command);
  expect(h.row()?.applyResult).toMatchObject({ rfWriteEvidence: "not_started", configurationMayHaveChanged: false });
  expect(h.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
});
it("publishes revision2 genuine RF0 after an already rejected start without reclaiming a successor", async () => {
  const h = await harness(false); await h.runtime.accept(h.command); expect(h.state()).toBe("rejected");
  h.normal(); const { payloadHash: _hash, ...base } = h.command;
  const body = { ...base, sessionId: "00000000-0000-4000-8000-000000000099", targets: base.targets.map(target => ({ ...target, applyGeneration: "3", releaseGeneration: "4" })) };
  await h.runtime.accept({ ...body, payloadHash: bioEnvelopeHash(body) });
  await release(h);
  expect(h.row()?.releaseResult).toMatchObject({ sessionRevision: 2, kind: "release", rfWriteEvidence: "not_started", configurationMayHaveChanged: false });
  expect(h.store.read().fixtureLeases[fixtureId]?.sessionId).toBe(body.sessionId);
  await h.outbox().confirm(ack(h.row()!.releaseResult!));
  expect(h.row()?.releaseAcknowledged).toBe(true);
  expect(h.store.read().fixtureLeases[fixtureId]?.sessionId).toBe(body.sessionId);
});
it("qualifies full normal configuration only from no-overlay GET and restores its sensor mode", async () => {
  const h = await harness(false); h.normal(); await h.runtime.accept(h.command); await release(h);
  expect(h.row()?.releaseResult).toMatchObject({ releaseConfirmed: true, configurationReadback: { configuredHighBrightnessPercent: 30, bioMode: "sensor" } });
});
it("restores partial high mutations and uses independent full GET", async () => {
  const h = await harness(); h.partial(); await h.runtime.accept(h.command);
  expect(h.row()?.partialMutation).toBe("high_brightness"); const before = h.reads(); await release(h);
  expect(h.row()?.releaseResult).toMatchObject({ releaseConfirmed: true, configurationReadback: { configuredHighBrightnessPercent: 40, bioMode: "force-on" } });
  expect(h.reads() - before).toBeGreaterThanOrEqual(2);
});
it("offline_expiry_uses_reserved_release_fence", async () => {
  const h = await harness(); await h.runtime.accept(h.command); h.revision(); h.advance(60_000);
  const runtime = h.runtime as any; expect(runtime.expire).toBeTypeOf("function"); await runtime.expire(h.now());
  expect(h.row()?.releaseResult).toMatchObject({ sessionRevision: 2, targetGeneration: "2", originCommandHash: h.command.payloadHash,
    admissionRevision: 7, restorationRevision: 8, restorationPayloadHash: h.current().payloadHash, releaseConfirmed: true });
});
it("reevaluates an unacknowledged release when the same snapshot schedule expires offline", async () => {
  const h = await harness(); await h.runtime.accept(h.command); await release(h);
  expect(h.configuration().configuredHighBrightnessPercent).toBe(40);
  h.advance(10 * 60 * 60 * 1000); await h.runtime.expire(h.now());
  expect(h.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
  expect(h.row()?.releaseResult?.restorationRevision).toBe(7);
});
it("end-before-start creates durable RF0 proof without inventing start", async () => {
  const h = await harness(); await release(h);
  expect(h.store.read().temporarySessions[sessionId]).toBeUndefined();
  expect(Object.values(h.store.read().temporaryResultOutbox)).toEqual([expect.objectContaining({ kind: "release", sessionRevision: 2,
    configurationMayHaveChanged: false, rfWriteEvidence: "not_started", originCommandHash: h.command.payloadHash })]);
  const restarted = new FileAutomationStateStore(h.path); await restarted.initialize(); await h.create(restarted).accept(h.command);
  expect(h.writes).toEqual([]);
});
