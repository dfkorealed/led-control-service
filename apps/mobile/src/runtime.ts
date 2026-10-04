import type { MobileBootstrapMessage } from '@led-control/shared/mobile-webview-contracts';
export type WebConfiguration = { ok: true; url: string; origin: string } | { ok: false; message: string };
export const developmentBuild = typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';

export function resolveWebConfiguration(value?: string, development = developmentBuild): WebConfiguration {
  if (!value?.trim()) return { ok: false, message: '서비스 연결 주소가 준비되지 않았습니다. 관리자에게 앱 설정을 확인해 주세요.' };
  try {
    const url = new URL(value);
    if (url.username || url.password || (url.protocol !== 'https:' && !(development && url.protocol === 'http:' && privateHost(url.hostname)))) {
      return { ok: false, message: development ? '개발 연결 주소는 HTTPS 또는 사설망 HTTP 주소여야 합니다.' : '운영 연결 주소는 HTTPS 주소여야 합니다.' };
    }
    if (url.pathname === '/' && !url.search && !url.hash) url.pathname = '/login';
    return { ok: true, url: url.href, origin: url.origin };
  } catch {
    return { ok: false, message: '서비스 연결 주소가 올바르지 않습니다. 앱 설정을 확인해 주세요.' };
  }
}

export function navigationDecision(value: string, trustedOrigin: string): 'internal' | 'external' | 'blocked' {
  try {
    const url = new URL(value);
    if (url.username || url.password) return 'blocked';
    if (url.origin === trustedOrigin && ['https:', 'http:'].includes(url.protocol)) return 'internal';
    // External redirects never receive native access silently: WebShell asks before OS handoff.
    if (['https:', 'mailto:', 'tel:'].includes(url.protocol)) return 'external';
  } catch { /* Malformed and non-URL input fails closed. */ }
  return 'blocked';
}

export function createMobileWebViewPreloadScript(origin: string): string {
  // WebView reuses this static prop across document navigations. It must never
  // carry an environment or document ID; only the current load-end callback can
  // bind a new JS document to the native bridge's current epoch.
  return `(() => {
    if (window.location.origin !== ${JSON.stringify(origin)}) return;
    window.__LED_CONTROL_MOBILE_WEBVIEW__ = true;
    document.documentElement.dataset.ledControlMobileWebview = 'true';
    document.documentElement.dataset.ledControlNativeSafeArea = 'true';
  })(); true;`;
}

export function createMobileWebViewBootstrapScript(origin: string, state: string, online = true, documentId = '', environment?: MobileBootstrapMessage): string {
  const bootstrap = environment ?? { version: 1, type: 'mobile.bootstrap', documentId, requestId: 'native-bootstrap', mobile: true, state: state === 'active' || state === 'background' ? state : 'inactive', online };
  return `(() => {
    if (window.location.origin !== ${JSON.stringify(origin)}) return;
    window.__LED_CONTROL_MOBILE_WEBVIEW__ = true;
    window.__LED_CONTROL_NATIVE_APP_STATE__ = ${JSON.stringify(state)};
    window.__LED_CONTROL_NATIVE_ONLINE__ = ${JSON.stringify(online)};
    window.__LED_CONTROL_NATIVE_DOCUMENT_ID__ = ${JSON.stringify(documentId)};
    window.__LED_CONTROL_NATIVE_ENVIRONMENT__ = ${JSON.stringify(bootstrap)};
    document.documentElement.dataset.ledControlNativeDocumentId = ${JSON.stringify(documentId)};
    window.dispatchEvent(new CustomEvent('led-control:native-message', { detail: window.__LED_CONTROL_NATIVE_ENVIRONMENT__ }));
    document.documentElement.dataset.ledControlMobileWebview = 'true';
    document.documentElement.dataset.ledControlNativeSafeArea = 'true';
    document.documentElement.dataset.ledControlNativeAppState = ${JSON.stringify(state)};
    window.dispatchEvent(new CustomEvent('led-control:webview-lifecycle', { detail: { state: ${JSON.stringify(state)} } }));
    window.dispatchEvent(new CustomEvent('led-control:webview-online', { detail: { online: ${JSON.stringify(online)} } }));
  })(); true;`;
}

function privateHost(value: string): boolean {
  const host = value.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || host === '::1' || host.endsWith('.localhost')) return true;
  const octets = host.split('.').map(Number);
  return octets.length === 4 && octets.every(v => Number.isInteger(v) && v >= 0 && v <= 255) &&
    (octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
}

export function createNativeMessageScript(origin: string, message: unknown): string {
  // Native injection may remain queued across a full reload. The origin alone
  // identifies the service, not the recipient JS realm. Full bootstrap binds
  // the current document first; every subsequent message must match that ID.
  return `(() => {
    const message = ${JSON.stringify(message)};
    if (window.location.origin !== ${JSON.stringify(origin)} || !message ||
        typeof message.documentId !== 'string' ||
        window.__LED_CONTROL_NATIVE_DOCUMENT_ID__ !== message.documentId) return;
    window.dispatchEvent(new CustomEvent('led-control:native-message', { detail: message }));
  })(); true;`;
}
