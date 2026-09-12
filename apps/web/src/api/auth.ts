import { useQuery } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPost } from "./client";
import { authMeQueryKey } from "./principal-cache";

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
    retry: false
  });
}

export interface MfaLoginChallenge {
  mfaRequired: true;
  challengeToken: string;
  expiresAt: string;
}

export type LoginResponse = { user: AuthUser } | MfaLoginChallenge;

export interface MfaStatus {
  enabled: boolean;
  enabledAt: string | null;
}

export interface MfaEnrollment {
  enrollmentToken: string;
  secret: string;
  otpauthUri: string;
  expiresAt: string;
}

export interface AuthSession {
  id: string;
  rememberMe: boolean;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
  mfaVerified: boolean;
}

export function login(input: { loginId: string; password: string; rememberMe: boolean }) {
  return apiPost<LoginResponse>("/auth/login", input);
}

export function completeMfaLogin(input: {
  challengeToken: string;
  code?: string;
  recoveryCode?: string;
}) {
  return apiPost<{ user: AuthUser; recoveryCodeUsed: boolean }>("/auth/login/mfa", input);
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
  return apiPost<{ ok: true; user: AuthUser }>("/auth/change-password", input);
}

export function getMfaStatus() {
  return apiGet<MfaStatus>("/auth/mfa");
}

export function startMfaEnrollment() {
  return apiPost<MfaEnrollment>("/auth/mfa/enrollment", {});
}

export function confirmMfaEnrollment(input: { enrollmentToken: string; code: string }) {
  return apiPost<{ mfaEnabled: true; recoveryCodes: string[] }>("/auth/mfa/enrollment/confirm", input);
}

export function disableMfa(input: { currentPassword: string; code?: string; recoveryCode?: string }) {
  return apiPost<{ mfaEnabled: false }>("/auth/mfa/disable", input);
}

export function listAuthSessions() {
  return apiGet<{ sessions: AuthSession[] }>("/auth/sessions");
}

export function revokeAuthSession(sessionId: string) {
  return apiDelete<{ ok: true }>(`/auth/sessions/${encodeURIComponent(sessionId)}`);
}

export function revokeOtherAuthSessions() {
  return apiPost<{ ok: true; revokedSessionCount: number }>("/auth/sessions/revoke-others", {});
}
