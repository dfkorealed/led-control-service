import type { QueryClient } from "@tanstack/react-query";
import { configureActiveCommandPersistence } from "../control/active-command-store";
import { isNativeMobileWebView, requiresNativeBootstrap, waitForMobileBootstrap } from "./mobile-environment";
import { createMobileQueryClient, initializeMobileRuntime } from "./mobile-runtime";
export async function startMobileWebEntry(mount: (client?: QueryClient) => void): Promise<() => void> {
  if (!requiresNativeBootstrap()) {
    configureActiveCommandPersistence(false);
    const dispose = initializeMobileRuntime(); mount(); return dispose;
  }
  await waitForMobileBootstrap();
  configureActiveCommandPersistence(isNativeMobileWebView());
  const dispose = initializeMobileRuntime(); mount(createMobileQueryClient()); return dispose;
}
