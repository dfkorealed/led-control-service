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

const appStateListeners = new Set<(state: string) => void>();

export const AppState = {
  currentState: "active",
  addEventListener(_event: "change", listener: (state: string) => void) {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  },
  emit(state: string) {
    this.currentState = state;
    appStateListeners.forEach((listener) => listener(state));
  },
  setCurrentState(state: string) {
    this.currentState = state;
  }
};
