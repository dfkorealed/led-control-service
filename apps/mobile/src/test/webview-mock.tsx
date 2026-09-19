import React from "react";

export const WebView = React.forwardRef(function WebView(
  props: Record<string, unknown>,
  ref: React.ForwardedRef<unknown>
) {
  return React.createElement("WebView", { ...props, ref });
});
