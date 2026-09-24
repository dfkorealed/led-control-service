import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTimeoutError } from "./client";
import {
  AUTH_REQUEST_TIMEOUT_MS,
  completeMfaLogin,
  getCurrentUser,
  login
} from "./auth";

describe("auth request deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["current user", () => getCurrentUser()],
    ["login", () => login({ loginId: "admin", password: "secret", rememberMe: true })],
    ["MFA", () => completeMfaLogin({ challengeToken: "challenge", code: "123456" })]
  ])("bounds the %s request without retrying the POST", async (_label, startRequest) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const request = startRequest();
    const rejection = expect(request).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
