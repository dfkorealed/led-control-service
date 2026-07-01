import React from "react";

export function SafeAreaView(props: Record<string, unknown>) {
  return React.createElement("SafeAreaView", props);
}

export function View(props: Record<string, unknown>) {
  return React.createElement("View", props);
}

export const StyleSheet = {
  create<T extends Record<string, unknown>>(styles: T) {
    return styles;
  }
};
