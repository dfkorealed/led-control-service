import { runInNewContext } from 'node:vm';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppState, Keyboard, Platform } from 'react-native';
import { WebShell } from './WebShell';
jest.mock('./private-files', () => ({ createPrivateFile: jest.fn(), sharePrivateFile: jest.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const origin = 'https://control.example.com';
const nativeKeyboard = Keyboard as unknown as { emit(event: string): void; addListener: jest.Mock };
const nativeState = AppState as unknown as { emit(state: string): void; setCurrentState(state: string): void };
let tree: ReactTestRenderer;
function shell(os: 'ios' | 'android' = 'ios') {
  Platform.OS = os; nativeState.setCurrentState('active');
  const frames: (() => void)[] = [];
  const scroll = jest.fn();
  const element = { tagName: 'INPUT', type: 'password', isConnected: true, readOnly: false, disabled: false,
    getBoundingClientRect: () => ({ top: 460, bottom: 506 }), scrollIntoView: scroll };
  const document = Object.assign(new EventTarget(), { documentElement: { dataset: {} }, activeElement: element, visibilityState: 'visible' });
  const window = Object.assign(new EventTarget(), { location: { origin }, top: undefined as unknown,
    visualViewport: Object.assign(new EventTarget(), { height: 436, offsetTop: 0 }), requestAnimationFrame: (callback: () => void) => frames.push(callback),
    getComputedStyle: () => ({ outlineStyle: 'none', outlineWidth: '0px', outlineOffset: '0px', boxShadow: 'rgb(0,0,0) 0px 0px 0px 3px' }) });
  window.top = window;
  const run = (script: string) => runInNewContext(script, { window, document, CustomEvent: class extends Event {} });
  const inject = jest.fn(run);
  act(() => { tree = create(<WebShell webUrl={origin} />, { createNodeMock: node => node.type === 'WebView' ? { injectJavaScript: inject } : {} }); });
  const props = () => tree.root.findByProps({ testID: 'control-webview' }).props;
  run(props().injectedJavaScriptBeforeContentLoaded);
  act(() => props().onLoadStart({ nativeEvent: { url: origin + '/login' } }));
  const load = () => act(() => props().onLoadEnd());
  const focus = () => document.dispatchEvent(new Event('focusin'));
  const frame = () => frames.splice(0).forEach(callback => callback());
  const show = () => act(() => nativeKeyboard.emit('keyboardDidShow'));
  return { props, load, focus, frame, show, scroll, window, inject };
}
afterEach(() => { act(() => tree?.unmount()); jest.clearAllMocks(); Platform.OS = 'android'; nativeState.setCurrentState('active'); });

it('connects an iOS first focus to native DidShow and only corrects after two live frames', () => {
  const p = shell(); p.load(); p.focus(); p.show(); p.frame(); expect(p.scroll).not.toHaveBeenCalled(); p.frame();
  expect(p.scroll).toHaveBeenCalledWith({ block: 'center', inline: 'nearest', behavior: 'auto' });
});
it.each(['keyboardWillHide', 'keyboardDidHide'])('cancels between frames on native %s', event => {
  const p = shell(); p.load(); p.focus(); p.show(); p.frame(); act(() => nativeKeyboard.emit(event)); p.frame(); expect(p.scroll).not.toHaveBeenCalled();
});
it.each(['inactive', 'background'])('cancels between frames on app %s and rejects later show', state => {
  const p = shell(); p.load(); p.focus(); p.show(); p.frame(); act(() => nativeState.emit(state)); p.frame(); p.show(); p.frame(); p.frame(); expect(p.scroll).not.toHaveBeenCalled();
});
it.each(['onError', 'onContentProcessDidTerminate', 'onRenderProcessGone'])('cancels between frames on %s', event => {
  const p = shell(); p.load(); p.focus(); p.show(); p.frame(); act(() => p.props()[event]()); p.frame(); p.show(); p.frame(); p.frame(); expect(p.scroll).not.toHaveBeenCalled();
});
it('cancels the old document before loading and binds new show signals to the new epoch', () => {
  const p = shell(); p.load(); p.focus(); p.show(); p.frame();
  act(() => p.props().onLoadStart({ nativeEvent: { url: origin + '/login' } }));
  p.frame(); p.show(); p.frame(); p.frame(); expect(p.scroll).not.toHaveBeenCalled();
  p.load(); p.focus(); p.show(); p.frame(); p.frame(); expect(p.scroll).toHaveBeenCalledTimes(1);
});
it('cancels a queued correction and removes native keyboard listeners on unmount', () => {
  const p = shell(); p.load(); p.focus(); p.show(); p.frame(); act(() => tree.unmount()); p.frame(); p.show(); p.frame(); p.frame(); expect(p.scroll).not.toHaveBeenCalled();
});
it('preserves focus gesture cancellation through repeated lifecycle bootstraps', () => {
  const p = shell(); p.load(); p.focus(); p.window.dispatchEvent(new Event('touchmove'));
  act(() => nativeState.emit('active')); p.show(); p.frame(); p.frame(); expect(p.scroll).not.toHaveBeenCalled();
});
it('does not install iOS browser logic or subscribe to native keyboard events on Android', () => {
  const p = shell('android'); p.load(); p.focus(); p.show(); p.frame(); p.frame();
  expect(nativeKeyboard.addListener).not.toHaveBeenCalled();
  expect((p.window as unknown as Record<string, unknown>).__LED_CONTROL_IOS_FOCUS_VISIBILITY__).toBeUndefined(); expect(p.scroll).not.toHaveBeenCalled();
});

it('rechecks an unhandled iOS focus after viewport shrink without another native DidShow', () => {
  const p=shell(); p.window.visualViewport.height=778; p.load(); p.focus(); p.show(); p.frame(); p.frame(); expect(p.scroll).not.toHaveBeenCalled();
  p.window.visualViewport.height=436; p.window.visualViewport.dispatchEvent(new Event('resize'));
  p.frame(); expect(p.scroll).not.toHaveBeenCalled(); p.frame(); expect(p.scroll).toHaveBeenCalledTimes(1);
});
