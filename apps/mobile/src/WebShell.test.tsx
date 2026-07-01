import { create } from "react-test-renderer";
import { WebShell } from "./WebShell";

describe("WebShell", () => {
  it("renders WebView with the configured web url", () => {
    const tree = create(<WebShell webUrl="http://localhost:5173" />);
    expect(tree.root.findByProps({ testID: "control-webview" }).props.source).toEqual({
      uri: "http://localhost:5173"
    });
  });
});
