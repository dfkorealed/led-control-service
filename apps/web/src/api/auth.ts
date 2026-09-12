import { useQuery, type QueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, isTransientApiError } from "./client";
import { authMeQueryKey, clearTenantCache } from "./principal-cache";
import { clearActiveCommandsForUser } from "../features/control/active-command-store";

export interface AuthUser {
  id: string;
  organizationId: string;
  organizationType: "service_provider" | "customer";
  loginId: string;
  name: string;
  role: "operator" | "admin" | "viewer";
  status: "active" | "disabled";
  mustChangePassword: boolean;
}

export function useCurrentUser() {
  return useQuery({
    queryKey: authMeQueryKey,
    queryFn: () => apiGet<{ user: AuthUser }>("/auth/me"),
    retry: (failureCount, error) => failureCount < 2 && isTransientApiError(error)
  });
}

export function login(input: { loginId: string; password: string; rememberMe: boolean }) {
  return apiPost<{ user: AuthUser }>("/auth/login", input);
}

export function signup(input: { token: string; loginId: string; email: string; name: string; password: string }) {
  return apiPost<{ user: AuthUser }>("/auth/signup", input);
}

export function logout() {
  return apiPost<{ ok: boolean }>("/auth/logout", {});
}

export async function reloginAfterRecovery(queryClient: QueryClient) {
  const auth = queryClient.getQueryData<{ user?: AuthUser } | null>(authMeQueryKey);
  await queryClient.cancelQueries();
  if (auth?.user) clearActiveCommandsForUser(auth.user.id);
  clearTenantCache(queryClient);
  queryClient.clear();
  queryClient.setQueryData(authMeQueryKey, null);
  const controller = new AbortController();
  // 장애 중인 logout도 로그인 화면을 영구히 막지 않도록 제한한다. 이 동안 새 로그인은 시작하지 않는다.
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  try {
    await apiPost("/auth/logout", {}, { signal: controller.signal });
  } catch {
    // 서버 세션 종료 실패와 무관하게 로컬 principal은 폐기하고 기존 로그인 화면으로 수렴한다.
  } finally {
    window.clearTimeout(timeout);
  }
}

export function changePassword(input: {
  currentPassword: string;
  newPassword: string;
  newPasswordConfirmation: string;
}) {
  return apiPost<{ ok: true; user: AuthUser }>("/auth/change-password", input);
}
