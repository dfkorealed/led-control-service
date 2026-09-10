import { QueryClient } from "@tanstack/react-query";
import type { AuthUser } from "./auth";
import { clearEditorDrafts } from "../features/floor-editor/editor-drafts";
import { useFloorEditorStore } from "../features/floor-editor/editor-store";

export const authMeQueryKey = ["auth", "me"] as const;

export interface PrincipalCacheGuard {
  expectedPrincipalKey: string;
  isOperationCurrent: () => boolean;
}

export function principalKey(user: Pick<AuthUser, "id" | "organizationId">) {
  return `${user.id}:${user.organizationId}`;
}

export function hasPrincipal(queryClient: QueryClient, expectedPrincipalKey: string) {
  const auth = queryClient.getQueryData<{ user?: AuthUser } | null>(authMeQueryKey);
  return Boolean(auth?.user && principalKey(auth.user) === expectedPrincipalKey);
}

export async function replacePrincipalCache(queryClient: QueryClient, auth: { user: AuthUser }, guard?: PrincipalCacheGuard) {
  if (!canApplyPrincipal(queryClient, auth, guard)) return false;
  await queryClient.cancelQueries();
  if (!canApplyPrincipal(queryClient, auth, guard)) return false;
  clearEditorDrafts();
  useFloorEditorStore.getState().reset();
  queryClient.clear();
  queryClient.setQueryData(authMeQueryKey, auth);
  return true;
}

export async function refreshPrincipalCache(queryClient: QueryClient, auth: { user: AuthUser }, guard: PrincipalCacheGuard) {
  if (!canApplyPrincipal(queryClient, auth, guard)) return false;
  await queryClient.cancelQueries({
    predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[0] !== "auth"
  });
  if (!canApplyPrincipal(queryClient, auth, guard)) return false;
  clearEditorDrafts();
  useFloorEditorStore.getState().reset();
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({
    predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[0] !== "auth"
  });
  queryClient.setQueryData(authMeQueryKey, auth);
  return true;
}

export function clearTenantCache(queryClient: QueryClient) {
  clearEditorDrafts();
  useFloorEditorStore.getState().reset();
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({
    predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[0] !== "auth"
  });
}

function canApplyPrincipal(queryClient: QueryClient, auth: { user: AuthUser }, guard?: PrincipalCacheGuard) {
  if (!guard) return true;
  return guard.isOperationCurrent()
    && principalKey(auth.user) === guard.expectedPrincipalKey
    && hasPrincipal(queryClient, guard.expectedPrincipalKey);
}
