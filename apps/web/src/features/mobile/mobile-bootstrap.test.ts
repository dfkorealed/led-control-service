import { afterEach, describe, expect, it, vi } from "vitest";
import { startMobileWebEntry } from "./mobile-bootstrap";
import { activeCommandStorageKey, configureActiveCommandPersistence } from "../control/active-command-store";
const boot = { version: 1, type: "mobile.bootstrap", documentId: "boot-doc", requestId: "boot", mobile: true, state: "active", online: true };
afterEach(() => { configureActiveCommandPersistence(false); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("entry bootstrap precedes principal/store mount", () => {
  it("does not call mount in native preparation and chooses durable storage before the first mount", async () => {
    vi.stubGlobal("ReactNativeWebView", { postMessage: vi.fn() }); vi.stubGlobal("__LED_CONTROL_NATIVE_ENVIRONMENT__", null); vi.stubGlobal("__LED_CONTROL_NATIVE_DOCUMENT_ID__", boot.documentId);
    const records: string[] = [];
    const pending = startMobileWebEntry(() => { records.push(activeCommandStorageKey("user", "site")); });
    await Promise.resolve(); expect(records).toEqual([]);
    window.__LED_CONTROL_NATIVE_ENVIRONMENT__ = boot;
    window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: boot })); const dispose = await pending;
    expect(records).toEqual(["led-control:active-command:mobile:v1:user:site"]);
    dispose();
  });
  it("mounts ordinary browsers immediately without changing their session storage prefix", async () => {
    vi.stubGlobal("ReactNativeWebView", undefined); vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Browser");
    const records: string[] = []; const pending = startMobileWebEntry(() => { records.push(activeCommandStorageKey("user", "site")); });
    expect(records).toEqual(["led-control:active-command:user:site"]); (await pending)();
  });
});
