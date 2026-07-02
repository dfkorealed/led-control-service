import { useQuery } from "@tanstack/react-query";
import { apiGet, apiPost } from "./client";

export interface AuthUser {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: string;
  status: string;
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiGet<{ user: AuthUser }>("/auth/me"),
    retry: false
  });
}

export function login(input: { email: string; password: string; rememberMe: boolean }) {
  return apiPost<{ user: AuthUser }>("/auth/login", input);
}

export function signup(input: { token: string; email: string; name: string; password: string }) {
  return apiPost<{ user: AuthUser }>("/auth/signup", input);
}

export function logout() {
  return apiPost<{ ok: boolean }>("/auth/logout", {});
}
