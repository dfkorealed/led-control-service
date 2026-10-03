import { focusManager, onlineManager, MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMobileQueryClient, initializeMobileRuntime } from "./mobile-runtime";
const boot = { version: 1, type: "mobile.bootstrap", documentId: "runtime-doc", requestId: "bootstrap", mobile: true, state: "active", online: true };
afterEach(() => { focusManager.setFocused(undefined); onlineManager.setOnline(true); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  const sent: unknown[] = [];
  vi.stubGlobal("ReactNativeWebView", { postMessage: (raw: string) => { sent.push(JSON.parse(raw)); } });
  vi.stubGlobal("__LED_CONTROL_NATIVE_ENVIRONMENT__", boot); vi.stubGlobal("__LED_CONTROL_NATIVE_DOCUMENT_ID__", boot.documentId);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  return sent;
}
function state(state: string, documentId = boot.documentId, online = true) {
  window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: { version: 1, type: "mobile.lifecycle", documentId, requestId: "lifecycle", state, online } }));
}
describe("native lifecycle query integration", () => {
  it("revalidates a stale active session once on background to active, not on duplicate or stale messages", async () => {
    const sent = setup(); const dispose = initializeMobileRuntime();
    let reads = 0; const client = new QueryClient(); client.mount();
    const observer = new QueryObserver(client, { queryKey: ["auth", "me"], queryFn: async () => { reads++; return { user: "current" }; }, initialData: { user: "previous" }, refetchOnMount: false });
    const unsubscribe = observer.subscribe(() => {});
    expect(sent).toContainEqual({ version: 1, type: "web.ready", documentId: "runtime-doc", requestId: "bootstrap" });
    state("background"); expect(focusManager.isFocused()).toBe(false);
    state("active", "old-document"); expect(focusManager.isFocused()).toBe(false);
    state("active"); await waitFor(() => expect(reads).toBe(1));
    state("active"); state("invented"); await Promise.resolve(); expect(reads).toBe(1);
    unsubscribe(); client.unmount(); client.clear(); dispose();
  });
  it("waits for document visibility and applies native connectivity without dispatching hardware commands", () => {
    setup(); const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const dispose = initializeMobileRuntime(); state("active"); expect(focusManager.isFocused()).toBe(false);
    visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange")); expect(focusManager.isFocused()).toBe(true);
    state("active", boot.documentId, false); expect(onlineManager.isOnline()).toBe(false);
    dispose();
  });
  it("answers only current-document back requests and does not add duplicate listeners on reinjection", () => {
    const sent = setup(); const dispose = initializeMobileRuntime(); const second = initializeMobileRuntime();
    window.history.replaceState({ idx: 0 }, "");
    for (const documentId of ["old", boot.documentId]) window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: { version: 1, type: "navigation.back", documentId, requestId: "back-1" } }));
    expect(sent.filter((value) => (value as { type: string }).type === "navigation.back.result")).toEqual([{ version: 1, type: "navigation.back.result", documentId: "runtime-doc", requestId: "back-1", handled: false, canGoBack: false }]);
    second(); dispose();
  });
  it("does not queue a mutation POST while offline or resend it on native reconnect", async () => {
    setup(); const dispose = initializeMobileRuntime(); const client = createMobileQueryClient(); client.mount();
    let posts = 0;
    const mutation = new MutationObserver(client, { mutationFn: async () => { posts++; throw new Error("offline"); } });
    onlineManager.setOnline(false); const result = mutation.mutate().catch(error => error);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(posts).toBe(1);
    expect(await result).toMatchObject({ message: "offline" });
    state("active"); await Promise.resolve(); expect(posts).toBe(1);
    client.unmount(); client.clear(); dispose();
  });
  it("does not move history twice for a repeated native back request ID", () => {
    setup(); const dispose = initializeMobileRuntime(); window.history.replaceState({ idx: 2 }, "");
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    for (let i = 0; i < 2; i++) window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: { version: 1, type: "navigation.back", documentId: boot.documentId, requestId: "same-back" } }));
    expect(back).toHaveBeenCalledTimes(1); dispose();
  });
  it("rebinds a validated fresh document bootstrap instead of dropping its lifecycle and back forever", () => {
    const sent = setup(); const dispose = initializeMobileRuntime();
    window.__LED_CONTROL_NATIVE_DOCUMENT_ID__ = "fresh-doc";
    window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: { ...boot, documentId: "fresh-doc", requestId: "fresh-bootstrap", state: "background" } }));
    expect(sent).toContainEqual({ version: 1, type: "web.ready", documentId: "fresh-doc", requestId: "fresh-bootstrap" });
    expect(focusManager.isFocused()).toBe(false);
    state("active", "fresh-doc"); expect(focusManager.isFocused()).toBe(true);
    dispose();
  });
});
