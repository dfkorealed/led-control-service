import { afterEach, expect, it, vi } from "vitest";
import { apiGet, apiRequest, isTransientApiError } from "./client";

afterEach(() => vi.unstubAllGlobals());
it.each([new TypeError("fetch failed"), new DOMException("timeout", "TimeoutError"), new DOMException("aborted by transport", "AbortError")])("catches failing to classify transport failure %s", async (failure) => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
  const error = await apiGet("/auth/me").catch((error: unknown) => error);
  expect(isTransientApiError(error)).toBe(true);
});
it("catches retrying caller cancellation or arbitrary programming TypeError", async () => {
  const controller = new AbortController();
  controller.abort();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("caller cancellation", "AbortError")));
  const error = await apiRequest("/auth/me", { signal: controller.signal }).catch((error: unknown) => error);
  expect(isTransientApiError(error)).toBe(false);
  expect(isTransientApiError(new TypeError("programming error"))).toBe(false);
});
it("catches retrying a JSON parser failure as a transport failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => { throw new TypeError("bad parser"); } }));
  const error = await apiGet("/auth/me").catch((error: unknown) => error);
  expect(isTransientApiError(error)).toBe(false);
});
