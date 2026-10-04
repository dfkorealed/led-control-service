import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, KeyboardAvoidingView, Linking, Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getNetworkStateAsync, addNetworkStateListener } from 'expo-network';
import { WebView } from 'react-native-webview';
import { RecoveryState } from './components/RecoveryState';
import { createMobileWebViewBootstrapScript, createMobileWebViewPreloadScript, createNativeMessageScript, navigationDecision, resolveWebConfiguration } from './runtime';
import { NativeBridge } from './native-bridge';
import { createPrivateFile, sharePrivateFile } from './private-files';

export { createMobileWebViewBootstrapScript } from './runtime';
export function WebShell({ webUrl }: { webUrl?: string }) {
  const configuration = resolveWebConfiguration(webUrl);
  if (!configuration.ok) return <RecoveryState testID="configuration-error" title="연결 준비가 필요합니다" message={configuration.message} />;
  return <ConnectedShell key={configuration.url} url={configuration.url} origin={configuration.origin} />;
}

function ConnectedShell({ url, origin }: { url: string; origin: string }) {
  const webView = useRef<WebView>(null);
  const appState = useRef(AppState.currentState);
  const online = useRef(true);
  const [initialDocumentId] = useState(createDocumentId);
  const documentId = useRef(initialDocumentId);
  const firstDocument = useRef(true);
  const activeGeneration = useRef(0);
  const currentUrl = useRef(url);
  const failed = useRef(false);
  const loaded = useRef(false);
  const documentLoaded = useRef(false);
  const externalPrompt = useRef(false);
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const bridgeRef = useRef<NativeBridge | null>(null);
  if (!bridgeRef.current) {
    bridgeRef.current = new NativeBridge(origin, message => webView.current?.injectJavaScript(createNativeMessageScript(origin, message)), createPrivateFile, sharePrivateFile, () => BackHandler.exitApp());
    bridgeRef.current.reset(documentId.current);
    bridgeRef.current.onBackTimeout = () => Alert.alert('뒤로가기를 처리하지 못했습니다', '현재 화면의 변경사항을 확인한 뒤 다시 시도해 주세요.');
  }
  const bridge = bridgeRef.current;
  const bootstrapScript = () => createMobileWebViewBootstrapScript(origin, appState.current, online.current, documentId.current, bridge.bootstrap(appState.current, online.current));
  const injectBootstrap = () => { if (!failed.current && documentLoaded.current) webView.current?.injectJavaScript(bootstrapScript()); };
  const currentCallback = () => activeGeneration.current === generation;

  useEffect(() => {
    let disposed = false;
    const updateOnline = (connected?: boolean, reachable?: boolean | null) => {
      const next = connected !== false && reachable !== false;
      if (!disposed && next !== online.current) { online.current = next; injectBootstrap(); bridge.lifecycle(appState.current, next); }
    };
    void getNetworkStateAsync().then(s => updateOnline(s.isConnected, s.isInternetReachable)).catch(() => {});
    const network = addNetworkStateListener(s => updateOnline(s.isConnected, s.isInternetReachable));
    const state = AppState.addEventListener('change', s => { appState.current = s; injectBootstrap(); bridge.lifecycle(s, online.current); });
    const back = Platform.OS === 'android' ? BackHandler.addEventListener('hardwareBackPress', () => { bridge.back(); return true; }) : undefined;
    return () => { disposed = true; network.remove(); state.remove(); back?.remove(); bridge.reset(''); };
  }, [origin]);
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setSlow(true), 15000);
    return () => clearTimeout(timer);
  }, [loading, generation]);

  const fail = (message: string) => { bridge.reset(''); failed.current = true; documentLoaded.current = false; setLoading(false); setError(message); };
  const retry = () => {
    failed.current = false; loaded.current = false; documentLoaded.current = false; currentUrl.current = url;
    documentId.current = createDocumentId(); firstDocument.current = true; bridge.reset(documentId.current); activeGeneration.current++;
    setError(null); setLoading(true); setSlow(false); setGeneration(g => g + 1);
  };
  const requestNavigation = (value: string, isTopFrame?: boolean) => {
    if (!currentCallback() || failed.current) return false;
    const requestedDocument = documentId.current;
    const decision = navigationDecision(value, origin);
    if (decision === 'internal') return true;
    if (decision === 'external' && isTopFrame !== false && !externalPrompt.current) {
      externalPrompt.current = true;
      Alert.alert('외부 앱에서 열기', '서비스 밖의 링크를 외부 앱에서 여시겠습니까?', [
        { text: '취소', style: 'cancel', onPress: () => { externalPrompt.current = false; } },
        { text: '열기', onPress: () => { externalPrompt.current = false; if (!currentCallback() || failed.current || requestedDocument !== documentId.current) return; void Linking.openURL(value).catch(() => Alert.alert('링크를 열 수 없습니다', '이 링크를 지원하는 앱을 확인해 주세요.')); } }
      ], { cancelable: true, onDismiss: () => { externalPrompt.current = false; } });
    }
    return false;
  };
  return <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>
    {/* Edge-to-edge Android delivers IME insets without resizing this root.
        RN's height behavior uses actual frame/keyboard overlap (and hide restores
        flex), so already-resized windows do not receive a second full IME inset.
        SafeAreaView padding is already included in the child's layout.y;
        adding its top inset as keyboardVerticalOffset would count it twice. */}
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.container}>
        <WebView key={generation} ref={webView} testID="control-webview" source={{ uri: url }} style={styles.webview}
          sharedCookiesEnabled androidLayerType="hardware" applicationNameForUserAgent="LEDControlNative/1"
          // Capture all schemes ourselves; a narrow whitelist delegates outside URLs to the OS before our policy runs.
          originWhitelist={['*']} onShouldStartLoadWithRequest={r => requestNavigation(r.url, r.isTopFrame)}
          onOpenWindow={e => requestNavigation(e.nativeEvent.targetUrl, true)}
          injectedJavaScriptBeforeContentLoaded={createMobileWebViewPreloadScript(origin)}
          onLoadStart={e => {
            if (!currentCallback()) return;
            if (navigationDecision(e.nativeEvent.url, origin) !== 'internal') { webView.current?.stopLoading(); fail('허용되지 않은 주소로 연결할 수 없습니다.'); return; }
            // Android emits loading-start for doUpdateVisitedHistory too. A
            // completed document's pushState/popstate changes its URL, not its
            // JS realm, so keep its ready/file/back ownership intact.
            if (Platform.OS === 'android' && e.nativeEvent.loading === false && documentLoaded.current) { currentUrl.current = e.nativeEvent.url; return; }
            documentLoaded.current = false;
            if (firstDocument.current) firstDocument.current = false;
            else { documentId.current = createDocumentId(); bridge.reset(documentId.current); }
            currentUrl.current = e.nativeEvent.url; failed.current = false;
            if (!loaded.current) setLoading(true);
          }}
          onMessage={e => {
            if (!currentCallback() || failed.current) return;
            void Promise.resolve(bridge.receive(e.nativeEvent.data, e.nativeEvent.url)).catch(() => Alert.alert('요청을 처리하지 못했습니다', '현재 화면을 확인한 뒤 다시 시도해 주세요.'));
          }}
          onLoad={e => { if (currentCallback() && !failed.current && navigationDecision(e.nativeEvent.url, origin) === 'internal') { loaded.current = true; setLoading(false); } }}
          onLoadEnd={() => { if (!currentCallback() || failed.current) return; documentLoaded.current = true; injectBootstrap(); setLoading(false); }}
          onError={() => { if (currentCallback()) fail('서비스에 연결하지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.'); }}
          onHttpError={e => { if (currentCallback() && e.nativeEvent.url === currentUrl.current) fail('서비스를 열 수 없습니다. 잠시 후 다시 시도해 주세요.'); }}
          onContentProcessDidTerminate={() => { if (currentCallback()) fail('앱 화면이 종료되었습니다. 다시 연결해 서버의 현재 상태를 확인해 주세요.'); }}
          onRenderProcessGone={() => { if (currentCallback()) fail('앱 화면이 종료되었습니다. 다시 연결해 서버의 현재 상태를 확인해 주세요.'); }}
          allowsBackForwardNavigationGestures={false} javaScriptCanOpenWindowsAutomatically={false}
          mixedContentMode="never" allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
          overScrollMode="never" bounces={false} />
        {(error || (loading && !loaded.current)) && <View style={styles.overlay}>
          <RecoveryState testID={error ? 'connection-error' : 'connection-loading'} title={error ? '연결하지 못했습니다' : '서비스 연결 중'}
            message={error ?? (slow ? '연결이 지연되고 있습니다. 네트워크를 확인해 주세요.' : '잠시만 기다려 주세요.')} retry={error || slow ? retry : undefined} loading={!error} />
        </View>}
      </View>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#f5f7fb' }, webview: { flex: 1, backgroundColor: '#f5f7fb' }, overlay: { ...StyleSheet.absoluteFill } });

let documentSequence = 0;
const realmNonce = Math.random().toString(36).slice(2, 12);
function createDocumentId(): string {
  // Document IDs are correlation, not authentication. Origin is checked independently.
  // The module-level sequence survives React remounts; the realm nonce isolates JS
  // restarts, whose previous callbacks cannot execute in the new native process.
  return `native-${realmNonce}-${++documentSequence}`;
}
