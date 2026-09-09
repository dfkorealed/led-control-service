import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { encodeHealthAttentionSet, decodeHealthAttentionStatus, requestHealthAttention } from "./health-attention";

afterEach(() => vi.useRealTimers());
it("encodes standard SIG 0x8005 and strictly decodes 0x8007", () => {
  expect([...encodeHealthAttentionSet(10)]).toEqual([0x80, 0x05, 10]);
  expect([...encodeHealthAttentionSet(0)]).toEqual([0x80, 0x05, 0]);
  expect(decodeHealthAttentionStatus(Uint8Array.from([0x80, 0x07, 10]))).toBe(10);
  for (const bytes of [[0x80, 0x06, 10], [0x80, 0x07], [0x80, 0x07, 10, 0]]) {
    expect(() => decodeHealthAttentionStatus(Uint8Array.from(bytes))).toThrow();
  }
  expect(() => encodeHealthAttentionSet(11)).toThrow();
});
it("waits for matching source and Attention seconds, not Send completion", async () => {
  const application = new EventEmitter();
  const send = vi.fn(async () => undefined);
  const response = requestHealthAttention(application, 256, 10, send, 1000);
  let settled = false;
  void response.then(() => { settled = true; });
  await Promise.resolve();
  application.emit("messageReceived", { source: 257, data: [0x80, 0x07, 10] });
  application.emit("messageReceived", { source: 256, data: [0x80, 0x07, 0] });
  expect(settled).toBe(false);
  application.emit("messageReceived", { source: 256, data: [0x80, 0x07, 10] });
  await expect(response).resolves.toBe(10);
  expect(application.listenerCount("messageReceived")).toBe(0);
});
it("bounds a hung send and cleans up on timeout and abort", async () => {
  vi.useFakeTimers();
  const application = new EventEmitter();
  const response = requestHealthAttention(application, 256, 10, () => new Promise(() => {}), 1000);
  const assertion = expect(response).rejects.toThrow("attention_timeout");
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
  expect(application.listenerCount("messageReceived")).toBe(0);
});
