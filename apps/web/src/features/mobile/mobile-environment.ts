import { mobileToWebMessageSchema, type MobileBootstrapMessage } from "@led-control/shared/mobile-webview-contracts";
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __LED_CONTROL_NATIVE_ENVIRONMENT__?: unknown;
    __LED_CONTROL_NATIVE_DOCUMENT_ID__?: unknown;
  }
}
export function getMobileEnvironment(): MobileBootstrapMessage | null {
  if (typeof window.ReactNativeWebView?.postMessage !== "function") return null;
  const result = mobileToWebMessageSchema.safeParse(window.__LED_CONTROL_NATIVE_ENVIRONMENT__);
  return result.success && result.data.type === "mobile.bootstrap" && result.data.documentId === window.__LED_CONTROL_NATIVE_DOCUMENT_ID__ ? result.data : null;
}
export function isNativeMobileWebView(): boolean { return getMobileEnvironment() !== null; }
export function requiresNativeBootstrap(): boolean {
  return typeof window.ReactNativeWebView?.postMessage === "function" || navigator.userAgent.includes("LEDControlNative/1");
}
/** Android may inject the transport/bootstrap only at onLoadEnd. Never mount
 * a native principal/command store using the browser storage adapter meanwhile.
 */
export function waitForMobileBootstrap(timeoutMs = 10_000): Promise<MobileBootstrapMessage | null> {
  const initial = getMobileEnvironment();
  if (initial || !requiresNativeBootstrap()) return Promise.resolve(initial);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener("led-control:native-message", receive); };
    const receive = (event: Event) => {
      const result = mobileToWebMessageSchema.safeParse((event as CustomEvent<unknown>).detail);
      if (!result.success || result.data.type !== "mobile.bootstrap" || result.data.documentId !== window.__LED_CONTROL_NATIVE_DOCUMENT_ID__) return;
      window.__LED_CONTROL_NATIVE_ENVIRONMENT__ = result.data;
      const environment = getMobileEnvironment();
      if (environment) { cleanup(); resolve(environment); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("MOBILE_BOOTSTRAP_TIMEOUT")); }, timeoutMs);
    window.addEventListener("led-control:native-message", receive);
    // Re-read after listener attachment so no bootstrap can fall between phases.
    const environment = getMobileEnvironment();
    if (environment) { cleanup(); resolve(environment); }
  });
}
