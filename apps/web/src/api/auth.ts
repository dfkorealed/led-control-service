import { useQuery } from "@tanstack/react-query";
import { apiGet, apiPost } from "./client";
import { authMeQueryKey } from "./principal-cache";

export interface AuthUser {
  id: string;
  organizationId: string;
  organizationType: "service_provider" | "customer";
  loginId: string;
  name: string;
  role: "operator" | "admin" | "viewer";
  status: "active" | "disabled";
}

export function useCurrentUser() {
  return useQuery({
    queryKey: authMeQueryKey,
    queryFn: () => apiGet<{ user: AuthUser }>("/auth/me"),
    retry: false
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

export function changePassword(input: {
  currentPassword: string;
  newPassword: string;
  newPasswordConfirmation: string;
}) {
  return apiPost<{ ok: boolean }>("/auth/change-password", input);
}
