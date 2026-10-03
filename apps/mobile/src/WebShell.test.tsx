import { runInNewContext } from 'node:vm';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppState, BackHandler, Alert, Linking, Platform } from 'react-native';
import { WebShell } from './WebShell';
jest.mock('./private-files', () => ({ createPrivateFile: jest.fn(() => { throw new Error('not requested by recovery tests'); }), sharePrivateFile: jest.fn(), cleanAbandonedShares: jest.fn() }));
function environment(script: string) {
  const window = { location: { origin: 'https://control.example.com' }, dispatchEvent() {} };
  runInNewContext(script, { window, document: { documentElement: { dataset: {} } }, CustomEvent: class {} });
  return (window as unknown as { __LED_CONTROL_NATIVE_ENVIRONMENT__: { documentId: string; requestId: string } }).__LED_CONTROL_NATIVE_ENVIRONMENT__;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer;
function findHost(name: string) { return tree.root.find(node => node.type === name); }
function render(url?: string, injectJavaScript = jest.fn()) {
  act(() => { tree = create(<WebShell webUrl={url ?? ''} />, { createNodeMock: e => e.type === 'WebView' ? { injectJavaScript } : {} }); });
  return () => tree.root.findByProps({ testID: 'control-webview' }).props;
}
afterEach(() => { act(() => tree?.unmount()); jest.useRealTimers(); jest.clearAllMocks(); Platform.OS = 'android'; });

describe('WebShell recovery', () => {
  it('enables Android IME overlap avoidance without applying the top safe area twice', () => {
    render('https://control.example.com');
    const avoidance = findHost('KeyboardAvoidingView');
    expect(avoidance.props.behavior).toBe('height');
    expect(avoidance.props.keyboardVerticalOffset ?? 0).toBe(0);
  });
  it('preserves the existing iOS keyboard padding behavior', () => {
    Platform.OS = 'ios'; render('https://control.example.com');
    expect(findHost('KeyboardAvoidingView').props.behavior).toBe('padding');
  });
  it('renders a configuration recovery screen without throwing when URL is missing', () => {
    render();
    expect(tree.root.findAllByProps({ testID: 'control-webview' })).toHaveLength(0);
    expect(tree.root.findByProps({ testID: 'configuration-error' })).toBeDefined();
  });
  it('normalizes origin to login and intercepts every navigation before OS handoff', () => {
    const props = render('https://control.example.com');
    expect(props().source.uri).toBe('https://control.example.com/login');
    expect(props().originWhitelist).toEqual(['*']);
    expect(props().applicationNameForUserAgent).toBe('LEDControlNative/1');
    expect(props().onShouldStartLoadWithRequest({ url: 'https://control.example.com/settings', isTopFrame: true })).toBe(true);
    expect(props().onShouldStartLoadWithRequest({ url: 'javascript:alert(1)', isTopFrame: true })).toBe(false);
  });
  it('keeps document errors visible when onLoadEnd follows a failed load', () => {
    const props = render('https://control.example.com');
    act(() => props().onError({ nativeEvent: { description: 'secret URL' } }));
    act(() => props().onLoadEnd());
    expect(tree.root.findByProps({ testID: 'connection-error' })).toBeDefined();
    act(() => tree.root.findByProps({ testID: 'retry-connection' }).props.onPress());
    expect(tree.root.findAllByProps({ testID: 'connection-error' })).toHaveLength(0);
  });
  it('only treats top-frame HTTP failures as document failures', () => {
    const props = render('https://control.example.com');
    act(() => props().onHttpError({ nativeEvent: { url: 'https://control.example.com/assets/missing.png', statusCode: 404 } }));
    expect(tree.root.findAllByProps({ testID: 'connection-error' })).toHaveLength(0);
    act(() => props().onHttpError({ nativeEvent: { url: 'https://control.example.com/login', statusCode: 503 } }));
    expect(tree.root.findByProps({ testID: 'connection-error' })).toBeDefined();
  });
  it('offers user-initiated process recovery rather than automatically replaying control', () => {
    const inject = jest.fn(); const props = render('https://control.example.com', inject);
    act(() => props().onLoadEnd());
    const initial = environment(inject.mock.calls.at(-1)?.[0]); inject.mockClear();
    act(() => props().onContentProcessDidTerminate());
    expect(tree.root.findByProps({ testID: 'connection-error' })).toBeDefined();
    act(() => props().onLoadEnd()); expect(inject).not.toHaveBeenCalled();
    act(() => tree.root.findByProps({ testID: 'retry-connection' }).props.onPress());
    act(() => props().onLoadStart({ nativeEvent: { url: 'https://control.example.com/login', loading: true } }));
    act(() => props().onLoadEnd());
    expect(environment(inject.mock.calls.at(-1)?.[0]).documentId).not.toBe(initial.documentId);
  });
  it('connects a ready document to Android Back without native history fallback', () => {
    const inject = jest.fn(); const props = render('https://control.example.com', inject);
    act(() => props().onLoadEnd());
    const initial = environment(inject.mock.calls.at(-1)?.[0]);
    act(() => props().onMessage({ nativeEvent: { data: JSON.stringify({ version: 1, type: 'web.ready', documentId: initial.documentId, requestId: initial.requestId }), url: 'https://control.example.com/login' } }));
    act(() => { (BackHandler as unknown as { emit(): boolean }).emit(); });
    expect(inject.mock.calls.at(-1)?.[0]).toContain('navigation.back');
    expect(BackHandler.exitApp).not.toHaveBeenCalled();
  });
  it('never embeds a document-bound environment in the static preload script', () => {
    const props = render('https://control.example.com');
    const script = props().injectedJavaScriptBeforeContentLoaded;
    expect(script).toContain('__LED_CONTROL_MOBILE_WEBVIEW__');
    expect(script).not.toContain('__LED_CONTROL_NATIVE_ENVIRONMENT__');
    expect(script).not.toContain('__LED_CONTROL_NATIVE_DOCUMENT_ID__');
    expect(script).not.toContain('mobile.bootstrap');
    expect(script).not.toContain('ledControlNativeDocumentId');
  });
  it('bootstraps each new document on load end and rejects readiness from its predecessor', () => {
    const inject = jest.fn(); const props = render('https://control.example.com', inject);
    const start = (url: string) => act(() => props().onLoadStart({ nativeEvent: { url } }));
    const ready = (env: { documentId: string; requestId: string }) => act(() => props().onMessage({ nativeEvent: { data: JSON.stringify({ version: 1, type: 'web.ready', documentId: env.documentId, requestId: env.requestId }), url: 'https://control.example.com/settings' } }));
    start('https://control.example.com/login');
    act(() => props().onLoadEnd());
    const first = environment(inject.mock.calls.at(-1)?.[0]); ready(first);
    start('https://control.example.com/settings'); inject.mockClear();
    act(() => (AppState as unknown as { emit(s: string): void }).emit('background'));
    expect(inject).not.toHaveBeenCalled();
    ready(first);
    act(() => { (BackHandler as unknown as { emit(): boolean }).emit(); });
    expect(inject).not.toHaveBeenCalled();
    act(() => props().onLoadEnd());
    const second = environment(inject.mock.calls.at(-1)?.[0]);
    expect(second.documentId).not.toBe(first.documentId);
    ready(second);
    act(() => { (BackHandler as unknown as { emit(): boolean }).emit(); });
    expect(inject.mock.calls.at(-1)?.[0]).toContain('navigation.back');
  });
  it('preserves the ready document through Android SPA history notifications', () => {
    const inject = jest.fn(); const props = render('https://control.example.com', inject);
    act(() => props().onLoadStart({ nativeEvent: { url: 'https://control.example.com/login', loading: true } }));
    act(() => props().onLoadEnd());
    const initial = environment(inject.mock.calls.at(-1)?.[0]);
    act(() => props().onMessage({ nativeEvent: { data: JSON.stringify({ version: 1, type: 'web.ready', documentId: initial.documentId, requestId: initial.requestId }), url: 'https://control.example.com/login' } }));
    act(() => props().onLoadStart({ nativeEvent: { url: 'https://control.example.com/settings', loading: false } }));
    act(() => (AppState as unknown as { emit(s: string): void }).emit('background'));
    const scripts = inject.mock.calls.map(call => call[0] as string);
    expect(scripts.filter(script => script.includes('__LED_CONTROL_NATIVE_ENVIRONMENT__')).map(script => environment(script).documentId)).toEqual([initial.documentId, initial.documentId]);
    act(() => { (BackHandler as unknown as { emit(): boolean }).emit(); });
    expect(inject.mock.calls.at(-1)?.[0]).toContain('navigation.back');
  });
  it('ignores callbacks from an obsolete WebView after a retry generation', () => {
    const props = render('https://control.example.com'); const obsolete = props();
    act(() => obsolete.onError()); act(() => tree.root.findByProps({ testID: 'retry-connection' }).props.onPress());
    act(() => obsolete.onError()); expect(tree.root.findAllByProps({ testID: 'connection-error' })).toHaveLength(0);
  });
  it('discards an external-link confirmation callback after document recovery', () => {
    const props = render('https://control.example.com');
    act(() => props().onShouldStartLoadWithRequest({ url: 'https://docs.example.com', isTopFrame: true }));
    const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2];
    act(() => props().onError()); act(() => tree.root.findByProps({ testID: 'retry-connection' }).props.onPress());
    act(() => buttons?.[1]?.onPress?.()); expect(Linking.openURL).not.toHaveBeenCalled();
  });
  it('uses the full bootstrap on load end and lifecycle updates', () => {
    const inject = jest.fn();
    const props = render('https://control.example.com', inject);
    act(() => props().onLoadEnd());
    expect(inject.mock.calls.at(-1)?.[0]).toContain('__LED_CONTROL_MOBILE_WEBVIEW__');
    act(() => (AppState as unknown as { emit(s: string): void }).emit('background'));
    expect(inject.mock.calls.at(-1)?.[0]).toContain('background');
  });
});
