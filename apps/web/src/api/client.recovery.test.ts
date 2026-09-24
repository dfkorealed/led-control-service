import { afterEach, expect, it, vi } from "vitest";
import {
  ApiError,
  ApiTimeoutError,
  ApiTransportError,
  apiGet,
  apiRequest,
  classifyApiFailure,
  isTransientApiError
} from "./client";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
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

it.each([
  [new ApiError("unauthorized", 401, null), "unauthorized", false],
  [new ApiError("forbidden", 403, null), "forbidden", false],
  [new ApiError("limited", 429, null), "rate_limited", false],
  [new ApiError("server", 500, null), "server", true],
  [new ApiTransportError("network"), "transport", true],
  [new ApiTimeoutError("timeout"), "timeout", true],
  [new TypeError("programming error"), "other", false]
] as const)("classifies %s as %s", (error, kind, transient) => {
  expect(classifyApiFailure(error)).toBe(kind);
  expect(isTransientApiError(error)).toBe(transient);
});

it("aborts and rejects a request when its explicit deadline elapses", async () => {
  vi.useFakeTimers();
  let requestSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init: RequestInit) => {
    requestSignal = init.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }));

  const request = apiGet("/auth/me", { timeoutMs: 8_000 });
  const rejection = expect(request).rejects.toBeInstanceOf(ApiTimeoutError);
  await vi.advanceTimersByTimeAsync(7_999);
  expect(requestSignal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  await rejection;
  expect(requestSignal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps caller cancellation distinct from an internal timeout", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("caller cancelled", "AbortError")), { once: true });
  })));

  const request = apiRequest("/auth/me", {}, { signal: controller.signal, timeoutMs: 8_000 });
  controller.abort();

  const error = await request.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(DOMException);
  expect(classifyApiFailure(error)).toBe("other");
  expect(isTransientApiError(error)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("clears the deadline after a successful response", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }));

  await expect(apiGet("/auth/me", { timeoutMs: 8_000 })).resolves.toEqual({ ok: true });
  expect(vi.getTimerCount()).toBe(0);
});
