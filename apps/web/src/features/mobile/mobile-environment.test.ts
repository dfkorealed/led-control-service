import { afterEach, describe, expect, it, vi } from "vitest";
import { getMobileEnvironment, isNativeMobileWebView, requiresNativeBootstrap, waitForMobileBootstrap } from "./mobile-environment";

const bootstrap = { version: 1, type: "mobile.bootstrap", documentId: "doc-1", requestId: "boot-1", mobile: true, state: "active", online: true };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function host(initial: unknown = bootstrap) {
  vi.stubGlobal("ReactNativeWebView", { postMessage: vi.fn() });
  vi.stubGlobal("__LED_CONTROL_NATIVE_ENVIRONMENT__", initial);
  vi.stubGlobal("__LED_CONTROL_NATIVE_DOCUMENT_ID__", "doc-1");
}
describe("verified native environment", () => {
  it("requires a strict bootstrap, matching document and callable transport", () => {
    host(); expect(isNativeMobileWebView()).toBe(true);
    window.__LED_CONTROL_NATIVE_DOCUMENT_ID__ = "doc-2";
    expect(getMobileEnvironment()).toBeNull();
    host({ ...bootstrap, token: "not-allowed" }); expect(isNativeMobileWebView()).toBe(false);
    host(); window.ReactNativeWebView = undefined; expect(isNativeMobileWebView()).toBe(false);
  });
  it("does not mount native callers before the late bootstrap arrives", async () => {
    host(null);
    const waiting = waitForMobileBootstrap();
    let mounted = false; void waiting.then(() => { mounted = true; });
    await Promise.resolve(); expect(mounted).toBe(false);
    host(); window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: bootstrap }));
    expect(await waiting).toMatchObject({ documentId: "doc-1" });
  });
  it("times out native preparation instead of treating it as an ordinary browser", async () => {
    vi.useFakeTimers(); host(null);
    const waiting = waitForMobileBootstrap(100);
    const settled = waiting.catch(error => error);
    await vi.advanceTimersByTimeAsync(100); expect(await settled).toMatchObject({ message: "MOBILE_BOOTSTRAP_TIMEOUT" });
  });
  it("recognizes the native UA even before transport injection, but mounts ordinary browsers immediately", async () => {
    host(null); window.ReactNativeWebView = undefined;
    const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Example LEDControlNative/1");
    expect(requiresNativeBootstrap()).toBe(true);
    agent.mockReturnValue("Ordinary Browser");
    expect(await waitForMobileBootstrap()).toBeNull();
  });
  it("waits when an earlier bootstrap is left behind under a fresh document ID", async () => {
    host(); window.__LED_CONTROL_NATIVE_DOCUMENT_ID__ = "fresh-doc";
    const waiting = waitForMobileBootstrap(); let ready = false; void waiting.then(() => { ready = true; });
    await Promise.resolve(); expect(ready).toBe(false);
    window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: { ...bootstrap, documentId: "fresh-doc" } }));
    expect(await waiting).toMatchObject({ documentId: "fresh-doc" });
  });
});
