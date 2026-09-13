import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiDelete, apiGet, apiPost } from "./client";
import {
  completeMfaLogin,
  confirmMfaEnrollment,
  disableMfa,
  getMfaStatus,
  listAuthSessions,
  login,
  revokeAuthSession,
  revokeOtherAuthSessions,
  startMfaEnrollment
} from "./auth";

vi.mock("./client", () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn() }));

describe("account security API", () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset().mockResolvedValue({});
    vi.mocked(apiPost).mockReset().mockResolvedValue({});
    vi.mocked(apiDelete).mockReset().mockResolvedValue({});
  });

  it("uses the backend login and MFA challenge contracts without query hooks", async () => {
    await login({ loginId: "admin_01", password: "secret", rememberMe: true });
    await completeMfaLogin({ challengeToken: "challenge", code: "123456" });
    await completeMfaLogin({ challengeToken: "challenge", recoveryCode: "recovery" });

    expect(apiPost).toHaveBeenNthCalledWith(1, "/auth/login", { loginId: "admin_01", password: "secret", rememberMe: true });
    expect(apiPost).toHaveBeenNthCalledWith(2, "/auth/login/mfa", { challengeToken: "challenge", code: "123456" });
    expect(apiPost).toHaveBeenNthCalledWith(3, "/auth/login/mfa", { challengeToken: "challenge", recoveryCode: "recovery" });
  });

  it("uses every MFA and session management endpoint exactly", async () => {
    await getMfaStatus();
    await startMfaEnrollment();
    await confirmMfaEnrollment({ enrollmentToken: "enrollment", code: "123456" });
    await disableMfa({ currentPassword: "secret", recoveryCode: "recovery" });
    await listAuthSessions();
    await revokeAuthSession("session/with slash");
    await revokeOtherAuthSessions();

    expect(apiGet).toHaveBeenNthCalledWith(1, "/auth/mfa");
    expect(apiPost).toHaveBeenNthCalledWith(1, "/auth/mfa/enrollment", {});
    expect(apiPost).toHaveBeenNthCalledWith(2, "/auth/mfa/enrollment/confirm", { enrollmentToken: "enrollment", code: "123456" });
    expect(apiPost).toHaveBeenNthCalledWith(3, "/auth/mfa/disable", { currentPassword: "secret", recoveryCode: "recovery" });
    expect(apiGet).toHaveBeenNthCalledWith(2, "/auth/sessions");
    expect(apiDelete).toHaveBeenCalledWith("/auth/sessions/session%2Fwith%20slash");
    expect(apiPost).toHaveBeenNthCalledWith(4, "/auth/sessions/revoke-others", {});
  });
});
