import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTimeoutError } from "./client";
import {
  AUTH_LOGOUT_TIMEOUT_MS,
  AUTH_REQUEST_TIMEOUT_MS,
  completeMfaLogin,
  getCurrentUser,
  login,
  logout
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

  it("reconciles an outcome-unknown logout timeout without retrying the POST", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const request = logout();
    await vi.advanceTimersByTimeAsync(AUTH_LOGOUT_TIMEOUT_MS);

    await expect(request).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/auth/logout", "/api/auth/me"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a bounded failure and leaves the active session recoverable when logout did not take effect", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: "still-active" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const request = logout();
    const rejection = expect(request).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(AUTH_LOGOUT_TIMEOUT_MS);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
