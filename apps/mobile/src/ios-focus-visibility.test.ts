import { runInNewContext } from 'node:vm';
import { createIosFocusVisibilityPreloadScript, createIosFocusVisibilitySignalScript } from './ios-focus-visibility';

const origin = 'https://control.example.com';
function page() {
  const calls: object[] = [];
  const frames: (() => void)[] = [];
  function input(top = 390, bottom = 436) {
    const element = {
      tagName: 'INPUT', type: 'password', readOnly: false, disabled: false, isConnected: true,
      getBoundingClientRect: () => ({ top, bottom, left: 41, right: 361, x: 41, y: top, width: 320, height: bottom - top }),
      scrollIntoView: (options: object) => { calls.push(options); },
      computed: { outlineStyle: 'none', outlineWidth: '0px', outlineOffset: '0px', boxShadow: 'rgba(37, 111, 161, 0.28) 0px 0px 0px 3px' },
    };
    for (const key of ['value', 'textContent', 'selectionStart', 'selectionEnd', 'style']) Object.defineProperty(element, key, { get() { throw Error('Private value or CSS access: ' + key); }, set() { throw Error('Private value or CSS write: ' + key); } });
    return element;
  }
  const document = Object.assign(new EventTarget(), { activeElement: input(), visibilityState: 'visible' });
  const window = Object.assign(new EventTarget(), {
    location: { origin }, top: undefined as unknown,
    innerHeight: 436, visualViewport: Object.assign(new EventTarget(), { height: 436, offsetTop: 0, scale: 1 }),
    __LED_CONTROL_NATIVE_DOCUMENT_ID__: 'one', __LED_CONTROL_NATIVE_APP_STATE__: 'active',
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; },
    getComputedStyle: (element: ReturnType<typeof input>) => element.computed,
  });
  window.top = window;
  const context = { window, document };
  const run = (script: string) => runInNewContext(script, context);
  const install = () => run(createIosFocusVisibilityPreloadScript(origin));
  const signal = (kind: 'show' | 'hide' | 'cancel' | 'dispose', documentId = 'one') => run(createIosFocusVisibilitySignalScript(origin, documentId, kind));
  const event = (kind: string) => document.dispatchEvent(new Event(kind));
  const gesture = (kind: string) => window.dispatchEvent(new Event(kind));
  const frame = () => { const batch = frames.splice(0); batch.forEach(callback => callback()); };
  const settle = () => { frame(); frame(); };
  return { calls, input, document, window, install, signal, event, gesture, frame, settle, pending: () => frames.length, resize: () => window.visualViewport.dispatchEvent(new Event('resize')) };
}

describe('iOS focused input visibility candidate', () => {
  it('corrects a clipped first-focus field once after two frames without reading values or writing CSS', () => {
    const p = page(); p.document.activeElement = p.input(420, 466); p.install(); p.event('focusin'); p.signal('show');
    expect(p.calls).toEqual([]); p.frame(); expect(p.calls).toEqual([]); p.frame();
    expect(p.calls).toEqual([{ block: 'center', inline: 'nearest', behavior: 'auto' }]);
    p.signal('show'); p.settle(); expect(p.calls).toHaveLength(1);
  });

  it('leaves a fully visible border and focus ring untouched', () => {
    const p = page(); p.document.activeElement = p.input(100, 146); p.install(); p.event('focusin'); p.signal('show'); p.settle();
    expect(p.calls).toEqual([]);
  });

  it.each(['touchmove', 'wheel', 'pointerdown'])('preserves %s intent between focus and native show', kind => {
    const p = page(); p.install(); p.event('focusin'); p.gesture(kind); p.signal('show'); p.settle();
    expect(p.calls).toEqual([]);
  });

  it('cancels a user gesture between the two animation frames', () => {
    const p = page(); p.install(); p.event('focusin'); p.signal('show'); p.frame(); p.gesture('touchmove'); p.frame();
    expect(p.calls).toEqual([]);
  });

  it.each(['hide', 'cancel', 'dispose'] as const)('cancels queued work on native %s between frames', kind => {
    const p = page(); p.install(); p.event('focusin'); p.signal('show'); p.frame(); p.signal(kind); p.frame();
    expect(p.calls).toEqual([]);
  });

  it.each(['background', 'inactive'])('cancels queued work when live app state becomes %s', state => {
    const p = page(); p.install(); p.event('focusin'); p.signal('show'); p.frame(); p.window.__LED_CONTROL_NATIVE_APP_STATE__ = state; p.frame();
    expect(p.calls).toEqual([]);
  });

  it('does not run a background-paused frame after document visibility changes', () => {
    const p = page(); p.install(); p.event('focusin'); p.signal('show'); p.frame(); p.document.visibilityState = 'hidden'; p.frame();
    expect(p.calls).toEqual([]);
  });

  it.each(['origin', 'document', 'frame'])('rechecks current %s at the second frame', change => {
    const p = page(); p.install(); p.event('focusin'); p.signal('show'); p.frame();
    if (change === 'origin') p.window.location.origin = 'https://foreign.example.com';
    if (change === 'document') p.window.__LED_CONTROL_NATIVE_DOCUMENT_ID__ = 'two';
    if (change === 'frame') p.window.top = {};
    p.frame(); expect(p.calls).toEqual([]);
  });

  it('rejects a queued signal for another document epoch', () => {
    const p = page(); p.install(); p.event('focusin'); p.signal('show', 'old'); p.settle();
    expect(p.calls).toEqual([]);
  });

  it('treats blur and same-element refocus as a fresh attempt', () => {
    const p = page(); p.install(); p.event('focusin'); p.signal('show'); p.frame();
    p.event('focusout'); p.event('focusin'); p.frame(); expect(p.calls).toEqual([]);
    p.frame(); expect(p.calls).toHaveLength(1);
  });

  it('corrects fresh Next focus without requiring another native DidShow', () => {
    const p = page(); p.install(); p.event('focusin'); p.signal('show'); p.settle();
    p.event('focusout'); p.document.activeElement = p.input(460, 506); p.event('focusin'); p.settle();
    expect(p.calls).toHaveLength(2);
  });

  it('cancels when focus changes before queued correction', () => {
    const p = page(); p.install(); p.event('focusin'); p.signal('show'); p.frame(); p.document.activeElement = p.input(); p.frame();
    expect(p.calls).toEqual([]);
  });

  it('deduplicates installation while an old callback is queued', () => {
    const p = page(); p.install(); p.event('focusin'); p.signal('show'); p.frame(); p.install(); p.signal('show'); p.settle();
    expect(p.calls).toHaveLength(1);
    p.event('focusout'); p.document.activeElement = p.input(460, 506); p.event('focusin'); p.settle();
    expect(p.calls).toHaveLength(2);
  });

  it.each(['readOnly', 'disabled', 'disconnected', 'nontext'])('ignores a %s control', state => {
    const p = page();
    if (state === 'readOnly') p.document.activeElement.readOnly = true;
    if (state === 'disabled') p.document.activeElement.disabled = true;
    if (state === 'disconnected') p.document.activeElement.isConnected = false;
    if (state === 'nontext') p.document.activeElement.type = 'checkbox';
    p.install(); p.event('focusin'); p.signal('show'); p.settle(); expect(p.calls).toEqual([]);
  });

  it('corrects a border-visible field whose actual zero-blur focus ring is clipped', () => {
    const p = page(); p.document.activeElement = p.input(386, 432); p.window.visualViewport.height = 433;
    p.install(); p.event('focusin'); p.signal('show'); p.settle(); expect(p.calls).toHaveLength(1);
  });

  it('includes an outer outline without overriding the control CSS', () => {
    const p = page(); p.document.activeElement = p.input(10, 56);
    p.document.activeElement.computed = { outlineStyle: 'solid', outlineWidth: '2px', outlineOffset: '2px', boxShadow: 'none' };
    p.window.visualViewport.offsetTop = 8; p.install(); p.event('focusin'); p.signal('show'); p.settle();
    expect(p.calls).toHaveLength(1);
  });

  it('does not mistake a blurred decorative shadow for an exact focus ring bound', () => {
    const p = page(); p.document.activeElement = p.input(386, 432);
    p.document.activeElement.computed.boxShadow = 'rgb(0, 0, 0) 0px 0px 16px 8px';
    p.install(); p.event('focusin'); p.signal('show'); p.settle(); expect(p.calls).toEqual([]);
  });

  it('allows a fresh keyboard opening without reusing the previous handled attempt', () => {
    const p = page(); p.install(); p.event('focusin'); p.signal('show'); p.settle();
    p.signal('hide'); p.signal('show'); p.settle();
    expect(p.calls).toHaveLength(2);
  });

  it.each(['hide', 'cancel'] as const)('drops an old opening gesture after %s before a fresh show', kind => {
    const p = page(); p.install(); p.event('focusin'); p.signal('show'); p.settle();
    p.gesture('touchmove'); p.signal(kind); p.signal('show'); p.settle();
    expect(p.calls).toHaveLength(2);
  });

  it('preserves a new opening gesture even if a second hide notification arrives', () => {
    const p = page(); p.install(); p.event('focusin'); p.signal('show'); p.settle();
    p.gesture('touchmove'); p.signal('hide'); p.gesture('wheel'); p.signal('hide'); p.signal('show'); p.settle();
    expect(p.calls).toHaveLength(1);
  });

  it('ends a cancelled pre-show attempt without carrying its gesture into a fresh opening', () => {
    const p = page(); p.install(); p.event('focusin'); p.gesture('touchmove'); p.signal('cancel'); p.signal('show'); p.settle();
    expect(p.calls).toHaveLength(1);
  });
});


describe('iOS viewport shrink during an unhandled keyboard opening', () => {
  function visibleOpening() {
    const p = page(); p.document.activeElement = p.input(100,146); p.install(); p.event('focusin'); p.signal('show'); p.settle();
    expect(p.calls).toEqual([]); return p;
  }
  it('rechecks a previously visible field when the same viewport later clips its ring', () => {
    const p = visibleOpening(); p.window.visualViewport.height = 148; p.resize();
    p.frame(); expect(p.calls).toEqual([]); p.frame();
    expect(p.calls).toEqual([{block:'center',inline:'nearest',behavior:'auto'}]);
  });
  it('coalesces a resize burst into one two-frame attempt', () => {
    const p = visibleOpening(); p.window.visualViewport.height=130; p.resize(); p.resize(); p.resize();
    expect(p.pending()).toBe(1); p.frame(); expect(p.pending()).toBe(1); p.resize(); expect(p.pending()).toBe(1);
    p.frame(); expect(p.calls).toHaveLength(1); expect(p.pending()).toBe(0);
  });
  it('does not correct a handled opening again after another shrink', () => {
    const p=page(); p.install(); p.event('focusin'); p.signal('show'); p.settle(); expect(p.calls).toHaveLength(1);
    p.window.visualViewport.height=100; p.resize(); p.settle(); expect(p.calls).toHaveLength(1); expect(p.pending()).toBe(0);
  });
  it.each(['touchmove','wheel','pointerdown'])('preserves %s cancellation through later resize', kind => {
    const p=visibleOpening(); p.gesture(kind); p.window.visualViewport.height=130; p.resize(); p.settle(); expect(p.calls).toEqual([]);
  });
  it.each(['hide','cancel','dispose'] as const)('cancels a resize attempt between frames on %s', kind => {
    const p=visibleOpening(); p.window.visualViewport.height=130; p.resize(); p.frame(); p.signal(kind); p.frame(); expect(p.calls).toEqual([]);
  });
  it('rejects a stale document during a resize attempt', () => {
    const p=visibleOpening(); p.window.visualViewport.height=130; p.resize(); p.frame(); p.window.__LED_CONTROL_NATIVE_DOCUMENT_ID__='two'; p.frame(); expect(p.calls).toEqual([]);
  });
  it('preserves the current focus and lifecycle checks during a resize attempt', () => {
    const p=visibleOpening(); p.window.visualViewport.height=130; p.resize(); p.frame(); p.event('focusout'); p.window.__LED_CONTROL_NATIVE_APP_STATE__='background'; p.frame(); expect(p.calls).toEqual([]);
  });
  it('does not move a field that remains fully visible after resize', () => {
    const p=visibleOpening(); p.window.visualViewport.height=300; p.resize(); p.settle(); expect(p.calls).toEqual([]);
  });
  it('unsubscribes from viewport events on dispose', () => {
    const p=visibleOpening(); const remove=jest.spyOn(p.window.visualViewport,'removeEventListener');
    p.signal('dispose'); expect(remove).toHaveBeenCalledWith('resize',expect.any(Function),undefined);
    p.window.visualViewport.height=130; p.resize(); expect(p.pending()).toBe(0); p.settle(); expect(p.calls).toEqual([]);
  });
});
