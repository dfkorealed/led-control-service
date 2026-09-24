import { useQuery } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPost, isApiStatus, isTransientApiError, type ApiRequestOptions } from "./client";
import { authMeQueryKey } from "./principal-cache";

export const AUTH_REQUEST_TIMEOUT_MS = 8_000;
export const AUTH_LOGOUT_TIMEOUT_MS = 8_000;
const AUTH_RECOVERY_LOGOUT_TIMEOUT_MS = 5_000;

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
    queryFn: ({ signal }) => getCurrentUser({ signal }),
    retry: (failureCount, error) => failureCount < 2 && isTransientApiError(error),
    // 세션 세대 교체 시 전달한 auth 결과를 즉시 재요청하지 않는다. 수동 retry/online resume는 유지한다.
    refetchOnMount: false,
    retryOnMount: false
  });
}

export function getCurrentUser(options: Pick<ApiRequestOptions, "signal"> = {}) {
  return apiGet<{ user: AuthUser }>("/auth/me", { ...options, timeoutMs: AUTH_REQUEST_TIMEOUT_MS });
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
  return apiPost<LoginResponse>("/auth/login", input, { timeoutMs: AUTH_REQUEST_TIMEOUT_MS });
}

export function completeMfaLogin(input: {
  challengeToken: string;
  code?: string;
  recoveryCode?: string;
}) {
  return apiPost<{ user: AuthUser; recoveryCodeUsed: boolean }>("/auth/login/mfa", input, { timeoutMs: AUTH_REQUEST_TIMEOUT_MS });
}

export function signup(input: { token: string; loginId: string; email: string; name: string; password: string }) {
  return apiPost<{ user: AuthUser }>("/auth/signup", input);
}

export async function logout() {
  try {
    return await apiPost<{ ok: boolean }>("/auth/logout", {}, { timeoutMs: AUTH_LOGOUT_TIMEOUT_MS });
  } catch (error) {
    if (!isTransientApiError(error)) throw error;
    // The server may have revoked the session before the POST response was
    // lost. Reconcile once with a separately bounded read; never retry logout.
    try {
      await getCurrentUser();
    } catch (reconciliationError) {
      if (isApiStatus(reconciliationError, 401)) return { ok: true };
      throw error;
    }
    // The principal still exists, so keep the local session and let the shell
    // unblock commands and present an explicit retry path.
    throw error;
  }
}

export async function logoutAfterRecovery() {
  // 장애 중인 logout도 로그인 화면을 영구히 막지 않도록 제한한다. 이 동안 새 로그인은 시작하지 않는다.
  try {
    await apiPost("/auth/logout", {}, { timeoutMs: AUTH_RECOVERY_LOGOUT_TIMEOUT_MS });
  } catch {
    // 서버 세션 종료 실패와 무관하게 로컬 principal은 폐기하고 기존 로그인 화면으로 수렴한다.
  }
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
