import { QueryClient } from "@tanstack/react-query";
import type { AuthUser } from "./auth";
import { clearEditorDrafts } from "../features/floor-editor/editor-drafts";
import { useFloorEditorStore } from "../features/floor-editor/editor-store";

export const authMeQueryKey = ["auth", "me"] as const;

export async function replacePrincipalCache(queryClient: QueryClient, auth: { user: AuthUser }) {
  clearEditorDrafts();
  useFloorEditorStore.getState().reset();
  await queryClient.cancelQueries();
  queryClient.clear();
  queryClient.setQueryData(authMeQueryKey, auth);
}

export async function refreshPrincipalCache(queryClient: QueryClient, auth: { user: AuthUser }) {
  clearEditorDrafts();
  useFloorEditorStore.getState().reset();
  await queryClient.cancelQueries({
    predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[0] !== "auth"
  });
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({
    predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[0] !== "auth"
  });
  queryClient.setQueryData(authMeQueryKey, auth);
}

export function clearTenantCache(queryClient: QueryClient) {
  clearEditorDrafts();
  useFloorEditorStore.getState().reset();
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({
    predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[0] !== "auth"
  });
}
