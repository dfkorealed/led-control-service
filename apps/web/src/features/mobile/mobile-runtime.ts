import { focusManager, onlineManager, QueryClient } from "@tanstack/react-query";
import { mobileToWebMessageSchema, webToMobileMessageSchema, type WebToMobileMessage } from "@led-control/shared/mobile-webview-contracts";
import { getMobileEnvironment } from "./mobile-environment";
import { handleMobileBack } from "./mobile-back";

export function postMobileMessage(message: WebToMobileMessage): void {
  const environment = getMobileEnvironment();
  if (!environment || message.documentId !== environment.documentId) throw new Error("FILE_DOCUMENT_CHANGED");
  window.ReactNativeWebView!.postMessage(JSON.stringify(webToMobileMessageSchema.parse(message)));
}
/** Queries keep their existing stale/poll policy. Native mutations must execute
 * once or fail immediately, never sit in Query's offline queue and resend a POST.
 */
export function createMobileQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { mutations: { networkMode: "always", retry: false } } });
}
let installed: (() => void) | undefined;
export function initializeMobileRuntime(): () => void {
  if (installed) return () => {};
  const initial = getMobileEnvironment();
  if (!initial) { onlineManager.setOnline(navigator.onLine); return () => {}; }
  let state = initial.state;
  let documentId = initial.documentId;
  const backResults = new Map<string, { handled: boolean; canGoBack: boolean }>();
  const applyFocus = () => focusManager.setFocused(state === "active" && document.visibilityState !== "hidden");
  // Native owns insets outside WebView; keep existing 68px web tabs but add no
  // second safe-area padding when the native scaffold declares ownership.
  document.documentElement.dataset.ledControlMobile = "true";
  document.documentElement.dataset.ledControlMobileWebview = "true";
  document.documentElement.dataset.ledControlNativeAppState = state;
  applyFocus(); onlineManager.setOnline(initial.online);
  const receive = (event: Event) => {
    const parsed = mobileToWebMessageSchema.safeParse((event as CustomEvent<unknown>).detail);
    if (!parsed.success) return;
    if (parsed.data.type === "mobile.bootstrap" && parsed.data.documentId === window.__LED_CONTROL_NATIVE_DOCUMENT_ID__ && typeof window.ReactNativeWebView?.postMessage === "function" && parsed.data.documentId !== documentId) {
      // A same-WebView SPA/load transition may rotate native document identity.
      // Rebind only the fresh strict bootstrap matching the native global. Keep
      // dirty drafts/principal intact, reset correlations, and revalidate GETs.
      documentId = parsed.data.documentId; backResults.clear();
      window.__LED_CONTROL_NATIVE_ENVIRONMENT__ = parsed.data;
      focusManager.setFocused(false);
    }
    const environment = getMobileEnvironment();
    if (!environment || environment.documentId !== documentId || parsed.data.documentId !== documentId) return;
    const message = parsed.data;
    if (message.type === "navigation.back") {
      const result = backResults.get(message.requestId) ?? handleMobileBack();
      backResults.set(message.requestId, result);
      if (backResults.size > 32) backResults.delete(backResults.keys().next().value!);
      postMobileMessage({ version: 1, documentId: message.documentId, requestId: message.requestId, type: "navigation.back.result", ...result });
    } else if (message.type === "mobile.lifecycle" || message.type === "mobile.bootstrap") {
      state = message.state;
      window.__LED_CONTROL_NATIVE_ENVIRONMENT__ = { ...environment, state, online: message.online };
      document.documentElement.dataset.ledControlNativeAppState = state;
      applyFocus(); onlineManager.setOnline(message.online);
      window.dispatchEvent(new CustomEvent("led-control:webview-lifecycle", { detail: { state, online: message.online } }));
      if (message.type === "mobile.bootstrap") acknowledge(message.requestId);
    }
  };
  function acknowledge(requestId: string) {
    postMobileMessage({ version: 1, documentId, requestId, type: "web.ready" });
  }
  // Replace default DOM listeners only in verified native mode, retaining DOM
  // visibility as a second gate. A native online signal is authoritative.
  focusManager.setEventListener(() => {
    document.addEventListener("visibilitychange", applyFocus);
    return () => document.removeEventListener("visibilitychange", applyFocus);
  });
  onlineManager.setEventListener(() => () => {});
  window.addEventListener("led-control:native-message", receive);
  acknowledge(initial.requestId);
  const cleanup = () => {
    window.removeEventListener("led-control:native-message", receive);
    focusManager.setEventListener((setFocused) => {
      const visibility = () => setFocused(document.visibilityState !== "hidden");
      window.addEventListener("visibilitychange", visibility);
      return () => window.removeEventListener("visibilitychange", visibility);
    });
    focusManager.setFocused(undefined);
    onlineManager.setEventListener((setOnline) => {
      const on = () => setOnline(true); const off = () => setOnline(false);
      window.addEventListener("online", on); window.addEventListener("offline", off);
      return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
    });
    delete document.documentElement.dataset.ledControlMobile;
    delete document.documentElement.dataset.ledControlMobileWebview;
    delete document.documentElement.dataset.ledControlNativeAppState;
    installed = undefined;
  };
  installed = cleanup;
  return cleanup;
}
