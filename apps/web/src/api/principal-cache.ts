import { QueryClient } from "@tanstack/react-query";
import type { AuthUser } from "./auth";

export const authMeQueryKey = ["auth", "me"] as const;

export async function replacePrincipalCache(queryClient: QueryClient, auth: { user: AuthUser }) {
  await queryClient.cancelQueries();
  queryClient.clear();
  queryClient.setQueryData(authMeQueryKey, auth);
}

export function clearTenantCache(queryClient: QueryClient) {
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({
    predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[0] !== "auth"
  });
}
