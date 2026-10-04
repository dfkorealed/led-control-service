import { runInNewContext } from 'node:vm';
import { createMobileWebViewBootstrapScript, createMobileWebViewPreloadScript, createNativeMessageScript, navigationDecision, resolveWebConfiguration } from './runtime';

describe('mobile runtime policy', () => {
  it('offers a recoverable configuration error instead of a localhost fallback', () => {
    expect(resolveWebConfiguration(undefined, false)).toEqual({ ok: false, message: expect.any(String) });
  });
  it('enters login only when a service origin has no explicit route', () => {
    expect(resolveWebConfiguration('https://control.example.com', false)).toMatchObject({ ok: true, url: 'https://control.example.com/login' });
    expect(resolveWebConfiguration('https://control.example.com/statistics?site=1#report', false)).toMatchObject({ url: 'https://control.example.com/statistics?site=1#report' });
  });
  it('rejects release HTTP, credentials, malformed URL and public development HTTP', () => {
    for (const url of ['http://192.168.1.2', 'https://user:secret@control.example.com', 'garbage']) expect(resolveWebConfiguration(url, false).ok).toBe(false);
    expect(resolveWebConfiguration('http://public.example.com', true).ok).toBe(false);
    expect(resolveWebConfiguration('http://192.168.1.2:5173', true).ok).toBe(true);
  });
  it('classifies external handoff separately and blocks executable URLs', () => {
    const origin = 'https://control.example.com';
    expect(navigationDecision(`${origin}/settings`, origin)).toBe('internal');
    expect(navigationDecision('https://docs.example.com', origin)).toBe('external');
    expect(navigationDecision('mailto:support@example.com', origin)).toBe('external');
    for (const url of ['javascript:alert(1)', 'data:text/html,evil', 'file:///tmp/report', 'intent://camera', 'http://evil.example.com', 'https://user:secret@control.example.com']) expect(navigationDecision(url, origin)).toBe('blocked');
  });
  it('full bootstrap remains idempotent and restores all native flags on load end', () => {
    const script = createMobileWebViewBootstrapScript('https://control.example.com', 'background', false, 'doc-1');
    expect(script).toContain('__LED_CONTROL_MOBILE_WEBVIEW__');
    expect(script).toContain('ledControlNativeSafeArea');
    expect(script).toContain('led-control:webview-lifecycle');
    expect(script).toContain('led-control:webview-online');
    expect(script).toContain('doc-1');
    expect(script).toContain('__LED_CONTROL_NATIVE_ENVIRONMENT__');
    const events: unknown[] = [];
    const document = { documentElement: { dataset: {} as Record<string, string> } };
    const window: { location: { origin: string }; __LED_CONTROL_NATIVE_DOCUMENT_ID__?: string; dispatchEvent(e: unknown): void } = {
      location: { origin: 'https://control.example.com' },
      dispatchEvent: (e: unknown) => { expect(window.__LED_CONTROL_NATIVE_DOCUMENT_ID__).toBe('doc-1'); events.push(e); }
    };
    const context = { window, document, CustomEvent: class { constructor(public type: string, public detail: unknown) {} } };
    runInNewContext(script, context); runInNewContext(script, context);
    expect(document.documentElement.dataset.ledControlNativeSafeArea).toBe('true');
    expect(window).toMatchObject({ __LED_CONTROL_MOBILE_WEBVIEW__: true, __LED_CONTROL_NATIVE_ONLINE__: false });
    expect(events).toHaveLength(6);
    expect(window).toHaveProperty('__LED_CONTROL_NATIVE_ENVIRONMENT__.type', 'mobile.bootstrap');
    const hostile = { window: { location: { origin: 'https://evil.example.com' } }, document, CustomEvent: context.CustomEvent };
    runInNewContext(script, hostile);
    expect(hostile.window).not.toHaveProperty('__LED_CONTROL_MOBILE_WEBVIEW__');
  });
  it('preloads only compatibility flags and leaves document binding to load end', () => {
    const script = createMobileWebViewPreloadScript('https://control.example.com');
    const document = { documentElement: { dataset: {} as Record<string, string> } };
    const window = { location: { origin: 'https://control.example.com' } };
    runInNewContext(script, { window, document }); runInNewContext(script, { window, document });
    expect(window).toMatchObject({ __LED_CONTROL_MOBILE_WEBVIEW__: true });
    expect(window).not.toHaveProperty('__LED_CONTROL_NATIVE_ENVIRONMENT__');
    expect(window).not.toHaveProperty('__LED_CONTROL_NATIVE_DOCUMENT_ID__');
    expect(document.documentElement.dataset).toEqual({ ledControlMobileWebview: 'true', ledControlNativeSafeArea: 'true' });
    const hostile = { location: { origin: 'https://evil.example.com' } };
    runInNewContext(script, { window: hostile, document });
    expect(hostile).not.toHaveProperty('__LED_CONTROL_MOBILE_WEBVIEW__');
  });
});

describe('native message transport', () => {
  it('dispatches the exact object on the origin-scoped CustomEvent', () => {
    const received: unknown[] = [];
    const payload = { version: 1, type: 'mobile.bootstrap', documentId: 'one', requestId: 'init', mobile: true, state: 'active', online: true };
    const window = { location: { origin: 'https://control.example.com' }, __LED_CONTROL_NATIVE_DOCUMENT_ID__: 'one', dispatchEvent: (event: unknown) => received.push(event) };
    runInNewContext(createNativeMessageScript('https://control.example.com', payload), { window, CustomEvent: class { constructor(public type: string, public options: unknown) {} } });
    expect(received).toEqual([{ type: 'led-control:native-message', options: { detail: payload } }]);
  });
  it('does not dispatch queued messages into a missing or different document epoch', () => {
    const payload = { version: 1, type: 'file.ack', documentId: 'old', requestId: 'file-1', nextSequence: 1, receivedBytes: 4 };
    for (const documentId of [undefined, 'new']) {
      const received: unknown[] = [];
      const window = { location: { origin: 'https://control.example.com' }, __LED_CONTROL_NATIVE_DOCUMENT_ID__: documentId, dispatchEvent: (event: unknown) => received.push(event) };
      runInNewContext(createNativeMessageScript('https://control.example.com', payload), { window, CustomEvent: class {} });
      expect(received).toEqual([]);
    }
  });
});
