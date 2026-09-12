import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BleMeshLightingObservation } from "../gateway";
import { CommandJournal } from "./command-journal";
import { handleGatewayStatusCheck } from "./gateway-status-check-handler";

const fixtureA = "66666666-6666-4666-8666-666666666666";
const fixtureB = "77777777-7777-4777-8777-777777777777";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function command() {
  const now = Date.now();
  return {
    commandId: "11111111-1111-4111-8111-111111111111",
    originalCommandId: "11111111-1111-4111-8111-111111111111",
    dispatchId: "22222222-2222-4222-8222-222222222222",
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    sequence: 1, siteId: "44444444-4444-4444-8444-444444444444",
    gatewayId: "55555555-5555-4555-8555-555555555555",
    targetFixtureIds: [fixtureA, fixtureB], expectedBrightness: 65, verificationAttempt: 1,
    requestedAt: new Date(now).toISOString(), deliveryGeneratedAt: new Date(now).toISOString(),
    deliveryGeneration: "88888888-8888-4888-8888-888888888888", deliveryWindowMs: 10000,
    expiresAt: new Date(now + 10000).toISOString()
  };
}

async function journalFile() {
  const directory = await mkdtemp(join(tmpdir(), "status-check-"));
  directories.push(directory);
  return join(directory, "journal.json");
}

function observationAdapter(observe: (emit: (id: string, brightness: number, powerOn?: boolean) => void, signal?: AbortSignal) => Promise<void>) {
  const listeners = new Set<(observation: BleMeshLightingObservation) => void>();
  const emit = (fixtureId: string, brightness: number, powerOn = true) => {
    for (const listener of listeners) listener({ fixtureId, brightness, powerOn, observedAt: new Date().toISOString() });
  };
  return {
    listeners,
    onLightingObservation: (listener: (observation: BleMeshLightingObservation) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    resyncLightingFixtures: vi.fn(async (_ids: string[], signal?: AbortSignal) => {
      await observe(emit, signal);
      return { total: 2, configured: 2, observed: 2, healthPending: 0, timedOut: 0, failed: 0 };
    })
  };
}

describe("handleGatewayStatusCheck", () => {
  it("persists acceptance before targeted Get and replays completed duplicates without another Get", async () => {
    const journal = new CommandJournal(await journalFile());
    const request = command();
    const events: string[] = [];
    const adapter = observationAdapter(async (emit) => {
      expect(await journal.get(request.idempotencyKey)).toMatchObject({ state: "accepted" });
      events.push("get");
      emit(fixtureA, 65); emit(fixtureB, 90, false);
    });
    const result = await handleGatewayStatusCheck(adapter, journal, request, async () => { events.push("acceptance"); }, {
      onDurableReceipt: () => events.push("durable")
    });
    expect(events).toEqual(["durable", "acceptance", "get"]);
    expect(result.deviceStatus).toMatchObject({ status: "succeeded", results: [
      { fixtureId: fixtureA, status: "succeeded", brightness: 65 },
      { fixtureId: fixtureB, status: "succeeded", brightness: 0 }
    ] });
    expect(result.observedFixtureIds).toEqual([fixtureA, fixtureB]);
    expect(await handleGatewayStatusCheck(adapter, journal, request)).toEqual(result);
    expect(adapter.resyncLightingFixtures).toHaveBeenCalledOnce();
    expect(adapter.resyncLightingFixtures).toHaveBeenCalledWith([fixtureA, fixtureB], expect.any(AbortSignal));
    expect(adapter.listeners.size).toBe(0);
  });

  it("keeps partial observations and times out only missing targets on deadline, aborting and detaching", async () => {
    let signal: AbortSignal | undefined;
    const adapter = observationAdapter(async (emit, receivedSignal) => {
      signal = receivedSignal;
      emit(fixtureA, 20);
      emit("99999999-9999-4999-8999-999999999999", 80);
      await new Promise<void>(() => undefined);
    });
    const result = await handleGatewayStatusCheck(adapter, new CommandJournal(await journalFile()), command(), undefined, { timeoutMs: 15 });
    expect(result.deviceStatus).toMatchObject({ status: "partially_succeeded", results: [
      { fixtureId: fixtureA, status: "succeeded", brightness: 20 },
      { fixtureId: fixtureB, status: "timed_out" }
    ] });
    expect(result.deviceStatus.results[1]).not.toHaveProperty("brightness");
    expect(result.observedFixtureIds).toEqual([fixtureA]);
    expect(signal?.aborted).toBe(true);
    expect(adapter.listeners.size).toBe(0);
  });

  it.each(["before acceptance", "after acceptance"])("does not Get when expired %s", async (stage) => {
    let expired = stage === "before acceptance";
    const durable = vi.fn();
    const adapter = observationAdapter(async () => undefined);
    const result = await handleGatewayStatusCheck(adapter, new CommandJournal(await journalFile()), command(), async () => { expired = true; }, {
      isCommandExpired: () => expired, onDurableReceipt: durable
    });
    expect(result.deviceStatus.status).toBe("timed_out");
    expect(result.fixtureStateObserved).toBe(false);
    expect(adapter.resyncLightingFixtures).not.toHaveBeenCalled();
    expect(durable).toHaveBeenCalledOnce();
  });

  it("recovers journal restart after acceptance as indeterminate without another Get", async () => {
    const path = await journalFile();
    const request = command();
    const adapter = observationAdapter(async () => undefined);
    await expect(handleGatewayStatusCheck(adapter, new CommandJournal(path), request, async () => {
      throw new Error("process stopped before acceptance publish");
    })).rejects.toThrow("process stopped");
    const stored = await new CommandJournal(path).get(request.idempotencyKey);
    const result = await handleGatewayStatusCheck(adapter, new CommandJournal(path), request);
    expect(result.acceptance).toEqual((stored?.command as { acceptance: unknown }).acceptance);
    expect(result.deviceStatus).toMatchObject({ status: "timed_out", results: [
      { fixtureId: fixtureA, status: "timed_out", faultCode: "GATEWAY_RESTART_INDETERMINATE" },
      { fixtureId: fixtureB, status: "timed_out", faultCode: "GATEWAY_RESTART_INDETERMINATE" }
    ] });
    expect(adapter.resyncLightingFixtures).not.toHaveBeenCalled();
    expect(await handleGatewayStatusCheck(adapter, new CommandJournal(path), request)).toEqual(result);
  });

  it("shares concurrent duplicate execution and its original terminal event", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const adapter = observationAdapter(async (emit) => { await barrier; emit(fixtureA, 65); emit(fixtureB, 65); });
    const journal = new CommandJournal(await journalFile());
    const request = command();
    const first = handleGatewayStatusCheck(adapter, journal, request);
    await vi.waitFor(() => expect(adapter.resyncLightingFixtures).toHaveBeenCalledOnce());
    const second = handleGatewayStatusCheck(adapter, journal, request);
    release();
    const results = await Promise.all([first, second]);
    expect(results[1]).toEqual(results[0]);
    expect(results[1].deviceStatus.status).toBe("succeeded");
    expect(adapter.resyncLightingFixtures).toHaveBeenCalledOnce();
  });

  it("aborts pending observation on shutdown and persists a terminal timeout", async () => {
    const stop = new AbortController();
    let signal: AbortSignal | undefined;
    const adapter = observationAdapter(async (_emit, received) => { signal = received; await new Promise<void>(() => undefined); });
    const journal = new CommandJournal(await journalFile());
    const request = command();
    const handling = handleGatewayStatusCheck(adapter, journal, request, undefined, { signal: stop.signal });
    await vi.waitFor(() => expect(adapter.resyncLightingFixtures).toHaveBeenCalledOnce());
    stop.abort();
    const result = await handling;
    expect(result.deviceStatus.status).toBe("timed_out");
    expect(signal?.aborted).toBe(true);
    expect(adapter.listeners.size).toBe(0);
    expect(await journal.get(request.idempotencyKey)).toMatchObject({ state: "completed", result });
  });

  it("uses broker TTL with an untrusted wall clock and treats failed resync as missing observations", async () => {
    let monotonic = 100;
    const adapter = observationAdapter(async () => { throw new Error("BlueZ unavailable"); });
    const result = await handleGatewayStatusCheck(adapter, new CommandJournal(await journalFile()), command(), undefined, {
      receipt: { receivedAtMonotonicMs: 0, brokerRemainingTtlMs: 100 },
      monotonicClock: () => monotonic, isCommandExpired: () => false
    });
    expect(result.acceptance.status).toBe("rejected");
    expect(adapter.resyncLightingFixtures).not.toHaveBeenCalled();
    monotonic = 0;
    const failed = await handleGatewayStatusCheck(adapter, new CommandJournal(await journalFile()), command(), undefined, {
      receipt: { receivedAtMonotonicMs: 0, brokerRemainingTtlMs: 100 },
      monotonicClock: () => monotonic, isCommandExpired: () => false
    });
    expect(failed.deviceStatus.status).toBe("timed_out");
    expect(failed.fixtureStateObserved).toBe(false);
    expect(adapter.listeners.size).toBe(0);
  });

  it("does not Get when broker TTL expires during asynchronous pre-execution validation", async () => {
    let monotonic = 0;
    let validations = 0;
    const adapter = observationAdapter(async () => undefined);
    const result = await handleGatewayStatusCheck(adapter, new CommandJournal(await journalFile()), command(), undefined, {
      receipt: { receivedAtMonotonicMs: 0, brokerRemainingTtlMs: 100 },
      monotonicClock: () => monotonic,
      isCommandExpired: async () => {
        await Promise.resolve();
        if (++validations === 2) monotonic = 100;
        return false;
      }
    });
    expect(validations).toBe(2);
    expect(result.acceptance.status).toBe("accepted");
    expect(result.deviceStatus.status).toBe("timed_out");
    expect(adapter.resyncLightingFixtures).not.toHaveBeenCalled();
    expect(adapter.listeners.size).toBe(0);
  });

  it("rechecks remaining TTL immediately before Get and detaches a listener installed at expiry", async () => {
    let monotonic = 0;
    const adapter = observationAdapter(async () => undefined);
    const subscribe = adapter.onLightingObservation;
    adapter.onLightingObservation = (listener) => {
      const detach = subscribe(listener);
      monotonic = 100;
      return detach;
    };
    const result = await handleGatewayStatusCheck(adapter, new CommandJournal(await journalFile()), command(), undefined, {
      receipt: { receivedAtMonotonicMs: 0, brokerRemainingTtlMs: 100 },
      monotonicClock: () => monotonic, isCommandExpired: async () => false
    });
    expect(result.deviceStatus.status).toBe("timed_out");
    expect(adapter.resyncLightingFixtures).not.toHaveBeenCalled();
    expect(adapter.listeners.size).toBe(0);
  });
});
