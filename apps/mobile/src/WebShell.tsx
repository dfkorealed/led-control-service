import { useEffect, useRef } from "react";
import { AppState, SafeAreaView, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";

interface WebShellProps {
  webUrl: string;
}

const developmentBuild = typeof __DEV__ !== "undefined"
  ? __DEV__
  : process.env.NODE_ENV !== "production";

export function resolveTrustedWebOrigin(webUrl: string, development = developmentBuild): string {
  let url: URL;
  try {
    url = new URL(webUrl);
  } catch {
    throw new Error("WEB_APP_URL은 올바른 URL이어야 합니다.");
  }
  if (url.protocol === "https:") return url.origin;
  if (development && url.protocol === "http:" && isPrivateDevelopmentHost(url.hostname)) {
    return url.origin;
  }
  if (development) throw new Error("개발 WEB_APP_URL은 localhost 또는 사설망 HTTP 주소만 허용합니다.");
  throw new Error("운영 WEB_APP_URL은 HTTPS 주소여야 합니다.");
}

export function createMobileWebViewBootstrapScript(trustedOrigin: string, appState: string): string {
  return `
  (() => {
    if (window.location.origin !== ${JSON.stringify(trustedOrigin)}) return;
    window.__LED_CONTROL_MOBILE_WEBVIEW__ = true;
    window.__LED_CONTROL_NATIVE_APP_STATE__ = ${JSON.stringify(appState)};
    document.documentElement.dataset.ledControlMobileWebview = "true";
    document.documentElement.dataset.ledControlNativeAppState = ${JSON.stringify(appState)};
  })();
  true;
`;
}

export function WebShell({ webUrl }: WebShellProps) {
  const webViewRef = useRef<React.ElementRef<typeof WebView>>(null);
  const currentAppState = useRef(AppState.currentState);
  const trustedOrigin = resolveTrustedWebOrigin(webUrl);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      currentAppState.current = state;
      webViewRef.current?.injectJavaScript(webViewLifecycleScript(trustedOrigin, state));
    });
    return () => subscription.remove();
  }, [trustedOrigin]);

  return (
    <SafeAreaView style={styles.container}>
      <WebView
        ref={webViewRef}
        testID="control-webview"
        source={{ uri: webUrl }}
        sharedCookiesEnabled
        androidLayerType="hardware"
        originWhitelist={[trustedOrigin]}
        onShouldStartLoadWithRequest={({ url }) => isTrustedNavigation(url, trustedOrigin)}
        injectedJavaScriptBeforeContentLoaded={createMobileWebViewBootstrapScript(
          trustedOrigin,
          currentAppState.current
        )}
        onLoadEnd={() => webViewRef.current?.injectJavaScript(
          webViewLifecycleScript(trustedOrigin, currentAppState.current)
        )}
        overScrollMode="never"
        bounces={false}
      />
    </SafeAreaView>
  );
}

function webViewLifecycleScript(trustedOrigin: string, state: string): string {
  return `if (window.location.origin === ${JSON.stringify(trustedOrigin)}) { window.__LED_CONTROL_NATIVE_APP_STATE__ = ${JSON.stringify(state)}; document.documentElement.dataset.ledControlNativeAppState = ${JSON.stringify(state)}; window.dispatchEvent(new CustomEvent("led-control:webview-lifecycle", { detail: { state: ${JSON.stringify(state)} } })); } true;`;
}

function isTrustedNavigation(value: string, trustedOrigin: string): boolean {
  try {
    return new URL(value).origin === trustedOrigin;
  } catch {
    return false;
  }
}

function isPrivateDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized.endsWith(".localhost")) return true;
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  return octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff"
  }
});
