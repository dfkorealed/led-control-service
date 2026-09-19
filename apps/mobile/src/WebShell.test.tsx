import { act, create } from "react-test-renderer";
import { AppState } from "react-native";
import { WebShell, resolveTrustedWebOrigin } from "./WebShell";

describe("WebShell", () => {
  it("renders WebView with the configured web url", () => {
    const tree = create(<WebShell webUrl="http://localhost:5173" />);
    expect(tree.root.findByProps({ testID: "control-webview" }).props.source).toEqual({
      uri: "http://localhost:5173"
    });
    tree.unmount();
  });

  it("uses the Android hardware layer and keeps map camera traffic inside JavaScript", () => {
    const tree = create(<WebShell webUrl="http://localhost:5173" />);
    const webView = tree.root.findByProps({ testID: "control-webview" });

    expect(webView.props.androidLayerType).toBe("hardware");
    expect(webView.props.injectedJavaScriptBeforeContentLoaded).toContain("__LED_CONTROL_MOBILE_WEBVIEW__");
    expect(webView.props.injectedJavaScriptBeforeContentLoaded).not.toContain("postMessage");
    expect(webView.props.onMessage).toBeUndefined();
    tree.unmount();
  });

  it("allows only the configured web origin and blocks external navigation", () => {
    const tree = create(<WebShell webUrl="https://control.example.com/customer" />);
    const webView = tree.root.findByProps({ testID: "control-webview" });

    expect(webView.props.originWhitelist).toEqual(["https://control.example.com"]);
    expect(webView.props.onShouldStartLoadWithRequest({ url: "https://control.example.com/settings" })).toBe(true);
    expect(webView.props.onShouldStartLoadWithRequest({ url: "https://evil.example/phishing" })).toBe(false);
    expect(webView.props.onShouldStartLoadWithRequest({ url: "javascript:alert(1)" })).toBe(false);
    tree.unmount();
  });

  it("requires HTTPS in production and permits configured private development origins only in development", () => {
    expect(() => resolveTrustedWebOrigin("http://192.168.0.25:5173", false)).toThrow(/HTTPS/);
    expect(resolveTrustedWebOrigin("http://192.168.0.25:5173", true)).toBe("http://192.168.0.25:5173");
    expect(() => resolveTrustedWebOrigin("http://example.com", true)).toThrow(/개발/);
  });

  it("injects the initial native AppState before web rendering starts", () => {
    (AppState as unknown as { setCurrentState(state: string): void }).setCurrentState("background");
    const tree = create(<WebShell webUrl="http://localhost:5173" />);
    const script = tree.root.findByProps({ testID: "control-webview" }).props.injectedJavaScriptBeforeContentLoaded;

    expect(script).toContain("ledControlNativeAppState");
    expect(script).toContain('"background"');
    tree.unmount();
    (AppState as unknown as { setCurrentState(state: string): void }).setCurrentState("active");
  });

  it("notifies the web renderer only for low-frequency app lifecycle changes", () => {
    const injectJavaScript = jest.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<WebShell webUrl="http://localhost:5173" />, {
        createNodeMock: (element) => element.type === "WebView" ? { injectJavaScript } : {}
      });
    });

    act(() => {
      (AppState as unknown as { emit(state: string): void }).emit("background");
      (AppState as unknown as { emit(state: string): void }).emit("active");
    });

    expect(injectJavaScript).toHaveBeenCalledTimes(2);
    expect(injectJavaScript.mock.calls[0][0]).toContain('"background"');
    expect(injectJavaScript.mock.calls[1][0]).toContain('"active"');
    tree.unmount();
  });
});
