import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as mqtt from "./temporary-control-mqtt";
import type { StartTemporaryControlCommand, TemporaryControlIngestedReceipt, TemporaryControlResult } from "@led-control/shared";
import { bioEnvelopeHash } from "../bio/bio-sensor-profile-catalog";
import { FileAutomationStateStore } from "./automation-state-store";
import { BioTemporaryControlRuntime } from "./bio-temporary-control-runtime";
import { TemporaryControlResultOutbox } from "./temporary-control-result-outbox";

const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const path = join(await mkdtemp(join(tmpdir(), "temporary-outbox-")), "state.json"); dirs.push(join(path, ".."));
  const store = new FileAutomationStateStore(path); await store.initialize();
  const body = { schemaVersion: 1 as const, kind: "start" as const, sessionId: "00000000-0000-4000-8000-000000000002", sessionRevision: 1 as const,
    siteId: "00000000-0000-4000-8000-000000000003", gatewayId: "00000000-0000-4000-8000-000000000004",
    assignmentVersion: 1, admissionRevision: 7, sequence: 9, brightness: 80,
    startedAt: "2026-10-14T00:00:00Z", endsAt: "2026-10-14T00:01:00Z",
    targets: [{ fixtureId: "00000000-0000-4000-8000-000000000001", meshNodeId: "00000000-0000-4000-8000-000000000001",
      nativeUuid: "001122334455", logicalAddress: "0x0001", applyGeneration: "1", releaseGeneration: "2" }] };
  const command: StartTemporaryControlCommand = { ...body, payloadHash: bioEnvelopeHash(body) };
  const noRF = async (): Promise<never> => { throw new Error("unavailable"); };
  const runtime = new BioTemporaryControlRuntime({ store, now: () => new Date(body.startedAt),
    clockTrust: { isTrusted: async () => true }, preflight: noRF, port: { read: noRF, apply: noRF, restore: noRF } });
  await runtime.accept(command);
  const result = Object.values(store.read().temporaryResultOutbox)[0]!;
  return { runtime, store, path, command, result, create: (nextStore = store) => new TemporaryControlResultOutbox(nextStore, body) };
}
function receipt(result: TemporaryControlResult): TemporaryControlIngestedReceipt {
  const { schemaVersion, eventId, sessionId, siteId, gatewayId, assignmentVersion, admissionRevision, originCommandHash,
    originSequence, sessionRevision, targetGeneration, resultHash } = result;
  return { schemaVersion, eventId, sessionId, siteId, gatewayId, assignmentVersion, admissionRevision, originCommandHash,
    originSequence, sessionRevision, targetGeneration, resultHash, status: "applied", reason: null, ingestedAt: "2026-10-14T00:00:01Z" };
}
it("durably retains results until exact application receipt, including restart", async () => {
  const h = await setup(), outbox = h.create();
  await outbox.persist(h.result);
  expect(await outbox.pending()).toEqual([h.result]);
  const restarted = new FileAutomationStateStore(h.path); await restarted.initialize(); const recovered = h.create(restarted);
  expect(await recovered.pending()).toEqual([h.result]);
  expect(await recovered.confirm({ ...receipt(h.result), resultHash: bioEnvelopeHash({}) })).toBe(false);
  expect(await recovered.pending()).toEqual([h.result]);
  expect(await recovered.confirm(receipt(h.result))).toBe(true);
  expect(await recovered.pending()).toEqual([]);
  expect(await recovered.confirm(receipt(h.result))).toBe(false);
  expect(restarted.read().fixtureLeases[h.result.fixtureId]?.releaseGeneration).toBe("2");
});
it.each(["siteId", "gatewayId", "sessionId", "originCommandHash", "originSequence", "admissionRevision", "targetGeneration"])("rejects mismatched %s receipt", async key => {
  const h = await setup(), ack: any = receipt(h.result);
  ack[key] = typeof ack[key] === "number" ? ack[key] + 1 : key === "originCommandHash" ? bioEnvelopeHash({}) : key === "targetGeneration" ? "99" : "00000000-0000-4000-8000-000000000099";
  expect(await h.create().confirm(ack)).toBe(false); expect(await h.create().pending()).toEqual([h.result]);
});
it("PUBACK never deletes a result and retry/drain is bounded even when publish hangs", async () => {
  const h = await setup(); vi.useFakeTimers();
  const Controller = (mqtt as any).TemporaryControlMqtt; expect(Controller).toBeTypeOf("function");
  const controller = new Controller({ scope: h.command, outbox: h.create(),
    runtime: { stopAndDrain: async () => {}, expire: async () => {} }, clockTrust: { isTrusted: async () => true },
    publishTimeoutMs: 50, retryInitialMs: 10, retryMaxMs: 20 });
  const delivered: unknown[] = [];
  await controller.connect(async (_topic: string, value: unknown) => { delivered.push(value); });
  expect(await h.create().pending()).toEqual([h.result]); expect(delivered).toEqual([h.result]);
  await vi.advanceTimersByTimeAsync(10); expect(delivered.length).toBe(2);
  controller.disconnect();
  const hung = controller.connect(async () => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(50); await hung;
  await controller.stopAndDrain();
  expect(vi.getTimerCount()).toBe(0); expect(await h.create().pending()).toEqual([h.result]);
});
it("serializes concurrent publisher wakeups without overlapping result batches", async () => {
  const h = await setup(); vi.useFakeTimers(); let active = 0, peak = 0;
  const controller = new mqtt.TemporaryControlMqtt({ scope: h.command, outbox: h.create(),
    runtime: { stopAndDrain: async () => {}, expire: async () => {}, accept: async () => {}, release: async () => {} },
    clockTrust: { isTrusted: async () => true } });
  const initial = controller.connect(async () => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
  });
  const wakes = [controller.wake(), controller.wake()];
  await vi.advanceTimersByTimeAsync(20); await Promise.all([initial, ...wakes]);
  await controller.stopAndDrain(); expect(peak).toBe(1);
});
it("observes an application receipt only after the current runtime operation drains", async () => {
  const h = await setup();
  let unblock!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const running = h.runtime.withReceiptSettlement(async () => { entered(); await gate; });
  await started;
  const controller = new mqtt.TemporaryControlMqtt({ scope: h.command, outbox: h.create(), runtime: h.runtime,
    now: () => new Date(h.command.startedAt), clockTrust: { isTrusted: async () => true },
    settleReceipt: operation => h.runtime.withReceiptSettlement(operation) });
  const settling = controller.handleReceipt(Buffer.from(JSON.stringify(receipt(h.result))));
  // Give a nonserialized durable receipt mutation enough time to become visible.
  await new Promise(resolve => setTimeout(resolve, 30));
  try { expect(await h.create().pending()).toEqual([h.result]); }
  finally { unblock(); await running; await settling; await controller.stopAndDrain(); }
  expect(await h.create().pending()).toEqual([]);
});
