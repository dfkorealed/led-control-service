import { describe, expect, it } from "vitest";
import * as contracts from "./index";

const c = contracts as unknown as Record<string, { safeParse: (value: unknown) => { success: boolean } }>;
const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const iso = "2026-10-14T00:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;
const target = { fixtureId: id, meshNodeId: other, nativeUuid: "001122334455", logicalAddress: "0x0001", applyGeneration: "1", releaseGeneration: "2" };
const command = { schemaVersion: 1, kind: "start", sessionRevision: 1, sessionId: id, siteId: id, gatewayId: other,
  assignmentVersion: 1, admissionRevision: 1, sequence: 1, payloadHash: hash, targets: [target], brightness: 100,
  startedAt: iso, endsAt: "2026-10-14T00:15:00.000Z" };
const create = { clientRequestId: id, target: { type: "fixture", fixtureId: id }, brightness: 0, durationMinutes: 1 };
const result = { schemaVersion: 1, sessionId: id, siteId: id, gatewayId: other, assignmentVersion: 1,
  admissionRevision: 1, originCommandHash: hash, originSequence: 1, fixtureId: id, eventId: other,
  sessionRevision: 1, kind: "apply", targetGeneration: "1", restorationRevision: null, restorationPayloadHash: null,
  observedAt: iso, resultHash: hash, applyConfirmed: true, releaseConfirmed: false, configurationMayHaveChanged: true,
  partialMutation: "none", configurationReadback: { configuredHighBrightnessPercent: 100, bioMode: "force-on" },
  rfWriteEvidence: "observed", reason: null };
const accepts = (name: string, value: unknown) => c[name]?.safeParse(value).success ?? false;

describe("temporary control strict contracts", () => {
  it("admits duration and brightness boundaries and rejects legacy TTL/unknown fields", () => {
    for (const brightness of [0, 100]) for (const durationMinutes of [1, 1440]) {
      expect(accepts("temporaryControlCreateSchema", { ...create, brightness, durationMinutes })).toBe(true);
    }
    for (const patch of [{ brightness: -1 }, { brightness: 101 }, { brightness: 1.5 }, { durationMinutes: 0 },
      { durationMinutes: 1441 }, { durationMinutes: 1.5 }, { overrideUntil: iso }, { siteId: id }]) {
      expect(accepts("temporaryControlCreateSchema", { ...create, ...patch })).toBe(false);
    }
    expect(accepts("temporaryControlEndSchema", { clientRequestId: id })).toBe(true);
    expect(accepts("temporaryControlEndSchema", { clientRequestId: id, durationMinutes: 1 })).toBe(false);
  });
  it("admits unique 1000 targets and rejects empty, duplicate and 1001 targets", () => {
    const fixtureIds = Array.from({ length: 1001 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
    for (const count of [1, 1000]) expect(accepts("temporaryControlCreateSchema", { ...create, target: { type: "fixtures", fixtureIds: fixtureIds.slice(0, count) } })).toBe(true);
    for (const ids of [[], [id, id], fixtureIds]) expect(accepts("temporaryControlCreateSchema", { ...create, target: { type: "fixtures", fixtureIds: ids } })).toBe(false);
    expect(accepts("temporaryControlCommandSchema", { ...command, targets: fixtureIds.slice(0, 1000).map(fixtureId => ({ ...target, fixtureId, meshNodeId: fixtureId, nativeUuid: Number(fixtureId.slice(-12)).toString(16).padStart(12, "0"), logicalAddress: `0x${(Number(fixtureId.slice(-12)) + 1).toString(16).padStart(4, "0")}` })) })).toBe(true);
    expect(accepts("temporaryControlCommandSchema", { ...command, targets: [target, target] })).toBe(false);
  });
  it("binds command discriminants, canonical generation pair and duration instants", () => {
    expect(accepts("temporaryControlCommandSchema", command)).toBe(true);
    const { brightness: _brightness, startedAt: _startedAt, ...base } = command;
    expect(accepts("temporaryControlCommandSchema", { ...base, kind: "end", sessionRevision: 2, originCommandHash: hash, originSequence: 1 })).toBe(true);
    for (const patch of [{ schemaVersion: 4 }, { sessionRevision: 2 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { payloadHash: "bad" }, { endsAt: iso }, { endsAt: "2026-10-15T00:01:00.000Z" }, { extra: true }]) {
      expect(accepts("temporaryControlCommandSchema", { ...command, ...patch })).toBe(false);
    }
    for (const applyGeneration of ["0", "01", "+1", "1.0", "-1", "1e3"]) expect(accepts("temporaryControlCommandSchema", { ...command, targets: [{ ...target, applyGeneration }] })).toBe(false);
    expect(accepts("temporaryControlCommandSchema", { ...command, targets: [{ ...target, releaseGeneration: "3" }] })).toBe(false);
    expect(accepts("temporaryControlCommandSchema", { ...command, targets: [{ ...target, applyGeneration: "9007199254740993", releaseGeneration: "9007199254740994" }] })).toBe(true);
  });
  it("keeps apply and restoration evidence separate and rejects unsupported confirmations", () => {
    expect(accepts("temporaryControlResultSchema", result)).toBe(true);
    const release = { ...result, kind: "release", sessionRevision: 2, targetGeneration: "2", releaseConfirmed: true,
      restorationRevision: 2, restorationPayloadHash: hash, configurationReadback: { configuredHighBrightnessPercent: 60, bioMode: "sensor" } };
    expect(accepts("temporaryControlResultSchema", release)).toBe(true);
    for (const patch of [{ sessionRevision: 1 }, { restorationRevision: null }, { restorationPayloadHash: null },
      { configurationReadback: null }, { rfWriteEvidence: "not_started" }, { partialMutation: "high_brightness" }]) expect(accepts("temporaryControlResultSchema", { ...release, ...patch })).toBe(false);
    expect(accepts("temporaryControlResultSchema", { ...result, configurationReadback: null })).toBe(false);
    expect(accepts("temporaryControlResultSchema", { ...result, applyConfirmed: false, partialMutation: "high_brightness", configurationReadback: null })).toBe(true);
  });
  it("binds view evidence to immutable target generation, scope and redaction", () => {
    const view = { id, siteId: id, gatewayId: other, state: "holding", sessionRevision: 1, now: iso, startedAt: iso,
      endsAt: command.endsAt, brightness: 100, targets: [target], results: [result], reason: null, detailsRedacted: false };
    expect(accepts("temporaryControlViewSchema", view)).toBe(true);
    for (const patch of [{ gatewayId: id }, { sessionId: other }, { fixtureId: other }, { targetGeneration: "2" }]) expect(accepts("temporaryControlViewSchema", { ...view, results: [{ ...result, ...patch }] })).toBe(false);
    expect(accepts("temporaryControlViewSchema", { ...view, detailsRedacted: true })).toBe(false);
    expect(accepts("temporaryControlViewSchema", { ...view, state: "restored", brightness: null, targets: [], results: [], detailsRedacted: true })).toBe(true);
    const { fixtureId: _fixtureId, kind: _kind, restorationRevision: _revision, restorationPayloadHash: _hash,
      observedAt: _observedAt, applyConfirmed: _apply, releaseConfirmed: _release, configurationMayHaveChanged: _changed,
      partialMutation: _partial, configurationReadback: _readback, rfWriteEvidence: _rf, ...identity } = result;
    const receipt = { ...identity, status: "applied", reason: null, ingestedAt: iso };
    expect(accepts("temporaryControlIngestedReceiptSchema", receipt)).toBe(true);
    expect(accepts("temporaryControlIngestedReceiptSchema", { ...receipt, resultHash: "bad" })).toBe(false);
  });
  it("does not promote an RF0 release over a possibly mutated apply to restored", () => {
    const noReleaseWrite = { ...result, eventId: id, kind: "release", sessionRevision: 2, targetGeneration: "2",
      applyConfirmed: false, releaseConfirmed: false, configurationMayHaveChanged: false,
      configurationReadback: null, rfWriteEvidence: "not_started" };
    const view = { id, siteId: id, gatewayId: other, state: "restored", sessionRevision: 2, now: iso,
      startedAt: iso, endsAt: command.endsAt, brightness: 100, targets: [target], results: [result, noReleaseWrite], reason: null, detailsRedacted: false };
    expect(accepts("temporaryControlViewSchema", view)).toBe(false);
    const unchangedApply = { ...result, applyConfirmed: false, configurationMayHaveChanged: false,
      configurationReadback: null, rfWriteEvidence: "not_started" };
    expect(accepts("temporaryControlViewSchema", { ...view, results: [unchangedApply, noReleaseWrite] })).toBe(true);
  });
  it("rejects mixed admission attribution inside one session view", () => {
    const observation = { ...result, eventId: id, kind: "observation", originCommandHash: `sha256:${"b".repeat(64)}` };
    const view = { id, siteId: id, gatewayId: other, state: "holding", sessionRevision: 1, now: iso,
      startedAt: iso, endsAt: command.endsAt, brightness: 100, targets: [target], results: [result, observation], reason: null, detailsRedacted: false };
    expect(accepts("temporaryControlViewSchema", view)).toBe(false);
  });
  it("holding requires target brightness and forced mode readback for every target", () => {
    const view = { id, siteId: id, gatewayId: other, state: "holding", sessionRevision: 1, now: iso,
      startedAt: iso, endsAt: command.endsAt, brightness: 100, targets: [target], results: [result], reason: null, detailsRedacted: false };
    expect(accepts("temporaryControlViewSchema", { ...view, results: [{ ...result, configurationReadback: { configuredHighBrightnessPercent: 60, bioMode: "force-on" } }] })).toBe(false);
    expect(accepts("temporaryControlViewSchema", { ...view, results: [{ ...result, configurationReadback: { configuredHighBrightnessPercent: 100, bioMode: "sensor" } }] })).toBe(false);
    expect(accepts("temporaryControlViewSchema", { ...view, brightness: 0, results: [{ ...result, configurationReadback: { configuredHighBrightnessPercent: 70, bioMode: "force-off" } }] })).toBe(true);
    for (const bioMode of ["sensor", "force-on"]) expect(accepts("temporaryControlViewSchema", { ...view, brightness: 0,
      results: [{ ...result, configurationReadback: { configuredHighBrightnessPercent: 70, bioMode } }] })).toBe(false);
  });
  it("cannot label a mutated then restored session rejected or cancelled", () => {
    const release = { ...result, kind: "release", eventId: id, sessionRevision: 2, targetGeneration: "2",
      releaseConfirmed: true, restorationRevision: 3, restorationPayloadHash: hash };
    const view = { id, siteId: id, gatewayId: other, state: "restored", sessionRevision: 2, now: iso,
      startedAt: iso, endsAt: command.endsAt, brightness: 100, targets: [target], results: [result, release], reason: null, detailsRedacted: false };
    expect(accepts("temporaryControlViewSchema", view)).toBe(true);
    for (const state of ["rejected", "cancelled"]) expect(accepts("temporaryControlViewSchema", { ...view, state })).toBe(false);
  });
  it("rejects restored when maximal-time release evidence includes unknown or partial in either order", () => {
    const release = { ...result, kind: "release", eventId: id, sessionRevision: 2, targetGeneration: "2",
      releaseConfirmed: true, restorationRevision: 3, restorationPayloadHash: hash };
    const ambiguous = { ...release, eventId: "00000000-0000-4000-8000-000000000003", kind: "observation",
      applyConfirmed: false, releaseConfirmed: false, configurationReadback: null, rfWriteEvidence: "may_have_written" };
    const view = { id, siteId: id, gatewayId: other, state: "restored", sessionRevision: 2, now: iso,
      startedAt: iso, endsAt: command.endsAt, brightness: 100, targets: [target], reason: null, detailsRedacted: false };
    for (const partialMutation of ["unverified", "high_brightness"]) {
      const unknown = { ...ambiguous, partialMutation };
      for (const pair of [[release, unknown], [unknown, release]]) {
        expect(accepts("temporaryControlViewSchema", { ...view, results: [result, ...pair] })).toBe(false);
      }
    }
    const equivalent = { ...release, eventId: ambiguous.eventId };
    for (const pair of [[release, equivalent], [equivalent, release]]) {
      expect(accepts("temporaryControlViewSchema", { ...view, results: [result, ...pair] })).toBe(true);
    }
  });
  it("rejects empty or over-limit immutable wire targets and validates BIO native identity", () => {
    expect(accepts("temporaryControlCommandSchema", { ...command, targets: [] })).toBe(false);
    expect(accepts("temporaryControlCommandSchema", { ...command, targets: Array.from({ length: 1001 }, () => target) })).toBe(false);
    for (const patch of [{ nativeUuid: "a".repeat(32) }, { nativeUuid: "AABBCCDDEEFF" }, { logicalAddress: "0x0000" },
      { logicalAddress: "0x8000" }, { logicalAddress: "0001" }, { extra: true }]) {
      expect(accepts("temporaryControlCommandSchema", { ...command, targets: [{ ...target, ...patch }] })).toBe(false);
    }
    expect(accepts("temporaryControlListQuerySchema", {})).toBe(true);
    for (const limit of [1, 100]) expect(accepts("temporaryControlListQuerySchema", { limit })).toBe(true);
    for (const limit of [0, 101]) expect(accepts("temporaryControlListQuerySchema", { limit })).toBe(false);
  });
});
