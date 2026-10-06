export type IosFocusVisibilitySignal = 'show' | 'hide' | 'cancel' | 'dispose';

// Standalone browser source keeps injection independent of an engine's function
// source availability. No DOM/value telemetry is sent.
export function createIosFocusVisibilityPreloadScript(origin: string): string {
  return String.raw`(() => {
    const origin = ${JSON.stringify(origin)};
    const trusted = () => window.top === window && window.location.origin === origin;
    if (!trusted() || window.__LED_CONTROL_IOS_FOCUS_VISIBILITY__) return;
    let target = null, keyboard = false, alive = true, moved = false, cancelled = false;
    let revision = 0, attempt = 0, handled = false, documentId = '', resizeAttempt = 0;
    const listeners = [];
    const listen = (host, type, callback, options) => {
      host.addEventListener(type, callback, options);
      listeners.push(() => host.removeEventListener(type, callback, options));
    };
    const active = () => trusted() && document.visibilityState === 'visible' && window.__LED_CONTROL_NATIVE_APP_STATE__ === 'active';
    const editable = element => element && element.isConnected && !element.readOnly && !element.disabled &&
      (element.tagName === 'TEXTAREA' || (element.tagName === 'INPUT' && ['text', 'password', 'email', 'search', 'tel', 'url', 'number'].includes(element.type)));
    const paint = element => {
      const style = window.getComputedStyle(element);
      const outline = style.outlineStyle === 'none' ? 0 : Math.max(0, (parseFloat(style.outlineWidth) || 0) + (parseFloat(style.outlineOffset) || 0));
      let top = outline, bottom = outline;
      // The actual focus ring has blur0/spread3px. Only zero-blur outer
      // shadows have exact bounds here; blurred decoration is not a ring.
      style.boxShadow.replace(/\([^)]*\)/g, '').split(',').forEach(shadow => {
        if (/\binset\b/.test(shadow)) return;
        const lengths = shadow.match(/-?\d*\.?\d+px/g);
        if (!lengths || lengths.length !== 4) return;
        const values = lengths.map(parseFloat);
        if (values[2] !== 0) return;
        top = Math.max(top, values[3] - values[1]);
        bottom = Math.max(bottom, values[3] + values[1]);
      });
      return {top, bottom};
    };
    const cancel = () => {
      revision++; attempt++;
      // End the old opening's gesture once. Duplicate hide/lifecycle signals
      // must not erase a new gesture between this boundary and the next show.
      if (!cancelled) moved = false;
      cancelled = true; keyboard = false; handled = false;
    };
    const schedule = () => {
      if (!alive || !keyboard || moved || handled || !active() || !editable(target)) return;
      const element = target, focusRevision = revision, work = ++attempt, epoch = documentId;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (resizeAttempt === work) resizeAttempt = 0;
        if (!alive || !keyboard || moved || handled || work !== attempt || focusRevision !== revision ||
            !active() || window.__LED_CONTROL_NATIVE_DOCUMENT_ID__ !== epoch ||
            document.activeElement !== element || target !== element || !editable(element)) return;
        const viewport = window.visualViewport;
        const top = viewport ? viewport.offsetTop : 0;
        const bottom = top + (viewport ? viewport.height : window.innerHeight);
        const rect = element.getBoundingClientRect();
        const outside = paint(element);
        if (rect.top - outside.top >= top && rect.bottom + outside.bottom <= bottom) return;
        element.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'auto'});
        handled = true;
      }));
      return work;
    };
    // WK's viewport can finish shrinking after DidShow's first two frames.
    // Recheck only unhandled focus; bursts share one pending resize attempt.
    // The live guards preserve gestures and one correction per focus/opening.
    if (window.visualViewport) listen(window.visualViewport, 'resize', () => {
      if (resizeAttempt && resizeAttempt === attempt) return;
      resizeAttempt = schedule() || 0;
    });
    listen(document, 'focusin', () => {
      revision++; target = document.activeElement; moved = false; handled = false;
      if (keyboard) schedule();
    });
    listen(document, 'focusout', () => { revision++; target = null; handled = false; });
    const gesture = () => { revision++; attempt++; moved = true; };
    ['touchmove', 'wheel', 'pointerdown'].forEach(type => listen(window, type, gesture, {passive: true}));
    listen(document, 'visibilitychange', () => { if (document.visibilityState !== 'visible') cancel(); });
    listen(window, 'led-control:webview-lifecycle', () => { if (!active()) cancel(); });
    window.__LED_CONTROL_IOS_FOCUS_VISIBILITY__ = { signal: (kind, epoch) => {
      if (!trusted() || window.__LED_CONTROL_NATIVE_DOCUMENT_ID__ !== epoch) return;
      if (kind === 'show') {
        if (!active()) return;
        documentId = epoch; cancelled = false; keyboard = true; schedule();
      } else {
        cancel();
        if (kind === 'dispose') {
          alive = false; listeners.forEach(remove => remove());
          delete window.__LED_CONTROL_IOS_FOCUS_VISIBILITY__;
        }
      }
    }};
  })(); true;`;
}

export function createIosFocusVisibilitySignalScript(origin: string, documentId: string, signal: IosFocusVisibilitySignal): string {
  return `(() => {
    if (window.top !== window || window.location.origin !== ${JSON.stringify(origin)} ||
        window.__LED_CONTROL_NATIVE_DOCUMENT_ID__ !== ${JSON.stringify(documentId)}) return;
    window.__LED_CONTROL_IOS_FOCUS_VISIBILITY__?.signal(${JSON.stringify(signal)}, ${JSON.stringify(documentId)});
  })(); true;`;
}
