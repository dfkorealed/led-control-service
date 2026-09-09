import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { FixtureIdentifyCommand } from "@led-control/shared";
import { FixtureIdentifyRuntime } from "./fixture-identify-runtime";

const siteId = randomUUID(), gatewayId = randomUUID(), fixtureId = randomUUID();
const command = (patch: Partial<FixtureIdentifyCommand> = {}): FixtureIdentifyCommand => {
  const now = Date.now();
  return ({
  version: 1, commandId: randomUUID(), sessionId: randomUUID(), siteId, gatewayId, fixtureId,
  action: "start", requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 10_000).toISOString(), ...patch
  });
};
afterEach(() => vi.useRealTimers());
function setup() {
  const attention = vi.fn(async (_fixture: string, _expires: number, action: string): Promise<number> => action === "start" ? 9 : 0);
  const runtime = new FixtureIdentifyRuntime({ siteId, gatewayId, setAttention: attention });
  return { runtime, attention };
}
it("rejects expired and cross-scope starts without Mesh writes", async () => {
  vi.useFakeTimers();
  const { runtime, attention } = setup();
  const old = command({ requestedAt: new Date(Date.now() - 11_000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
  expect(await runtime.handle(old)).toMatchObject({ status: "rejected", reason: "command_expired" });
  await expect(runtime.handle(command({ gatewayId: randomUUID() }))).rejects.toThrow("scope");
  expect(attention).not.toHaveBeenCalled();
  await runtime.stop();
});
it("a stop received before a delayed start tombstones that session", async () => {
  vi.useFakeTimers();
  const { runtime, attention } = setup();
  await vi.advanceTimersByTimeAsync(10_001);
  const start = command();
  expect(await runtime.handle(command({ action: "stop", sessionId: start.sessionId }))).toMatchObject({ reason: "stale_session" });
  expect(await runtime.handle(start)).toMatchObject({ reason: "duplicate_session" });
  expect(attention).not.toHaveBeenCalled();
  await runtime.stop();
});
it("serializes one session, rejects duplicates and cannot stop a newer target", async () => {
  vi.useFakeTimers();
  const { runtime, attention } = setup();
  await vi.advanceTimersByTimeAsync(10_001);
  const first = command();
  expect(await runtime.handle(first)).toMatchObject({ status: "attention_confirmed" });
  expect(await runtime.handle(first)).toMatchObject({ status: "rejected", reason: "duplicate_command" });
  expect(await runtime.handle(command())).toMatchObject({ status: "rejected", reason: "gateway_busy" });
  expect(await runtime.handle(command({ action: "stop", sessionId: first.sessionId }))).toMatchObject({ status: "stopped" });
  const second = command({ fixtureId: randomUUID() });
  expect(await runtime.handle(second)).toMatchObject({ status: "attention_confirmed" });
  expect(await runtime.handle(command({ action: "stop", sessionId: first.sessionId }))).toMatchObject({ status: "rejected", reason: "stale_session" });
  expect(attention).toHaveBeenCalledTimes(3);
  await runtime.stop();
});
it("retains uncertain starts until TTL and never reports publish/send success", async () => {
  vi.useFakeTimers();
  const { runtime, attention } = setup();
  await vi.advanceTimersByTimeAsync(10_001);
  attention.mockRejectedValue(new Error("attention_timeout"));
  expect(await runtime.handle(command())).toMatchObject({ status: "timed_out", reason: "attention_timeout" });
  expect(await runtime.handle(command())).toMatchObject({ reason: "gateway_busy" });
  await vi.advanceTimersByTimeAsync(10_001);
  attention.mockResolvedValue(9);
  expect(await runtime.handle(command())).toMatchObject({ status: "attention_confirmed" });
  await runtime.stop();
});
it("blocks pre-restart replay and observes a ten-second startup safety window", async () => {
  const { runtime, attention } = setup();
  expect(await runtime.handle(command())).toMatchObject({ reason: "gateway_starting" });
  expect(attention).not.toHaveBeenCalled();
  await runtime.stop();
});
it("aborts hung adapter work and bounds shutdown cleanup without dangling timers", async () => {
  vi.useFakeTimers();
  const { runtime, attention } = setup();
  await vi.advanceTimersByTimeAsync(10_001);
  attention.mockImplementation(() => new Promise(() => {}));
  const pending = runtime.handle(command());
  await vi.advanceTimersByTimeAsync(2200);
  await expect(pending).resolves.toMatchObject({ status: "timed_out", reason: "attention_timeout" });
  const stopped = runtime.stop();
  await vi.advanceTimersByTimeAsync(2000);
  await stopped;
  expect(vi.getTimerCount()).toBe(0);
  await expect(runtime.handle(command())).resolves.toMatchObject({ reason: "gateway_stopping" });
});
