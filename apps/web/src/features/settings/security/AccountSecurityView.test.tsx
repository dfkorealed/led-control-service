import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmMfaEnrollment,
  disableMfa,
  getMfaStatus,
  listAuthSessions,
  revokeAuthSession,
  revokeOtherAuthSessions,
  startMfaEnrollment,
  type AuthUser
} from "../../../api/auth";
import { authMeQueryKey } from "../../../api/principal-cache";
import { AccountSecurityView } from "./AccountSecurityView";

vi.mock("../../../api/auth", async (original) => ({
  ...await original<typeof import("../../../api/auth")>(),
  getMfaStatus: vi.fn(),
  startMfaEnrollment: vi.fn(),
  confirmMfaEnrollment: vi.fn(),
  disableMfa: vi.fn(),
  listAuthSessions: vi.fn(),
  revokeAuthSession: vi.fn(),
  revokeOtherAuthSessions: vi.fn(),
  changePassword: vi.fn()
}));

const admin: AuthUser = {
  id: "admin-1", organizationId: "customer-1", organizationType: "customer",
  loginId: "admin_01", name: "관리자", role: "admin", status: "active", mustChangePassword: false
};
const viewer: AuthUser = { ...admin, id: "viewer-1", loginId: "viewer_01", role: "viewer" };
const otherAdmin: AuthUser = { ...admin, id: "admin-2", organizationId: "customer-2", loginId: "admin_02" };
const sessions = [
  {
    id: "session-current", rememberMe: true, userAgent: "Chrome on macOS", ipAddress: "192.0.2.10",
    createdAt: "2026-09-12T10:00:00.000Z", expiresAt: "2026-10-12T10:00:00.000Z",
    current: true, mfaVerified: true
  },
  {
    id: "session-other", rememberMe: false, userAgent: null, ipAddress: null,
    createdAt: "2026-09-11T10:00:00.000Z", expiresAt: "2026-09-13T10:00:00.000Z",
    current: false, mfaVerified: false
  }
];

function renderView(user: AuthUser = admin) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(authMeQueryKey, { user });
  render(<QueryClientProvider client={client}><AccountSecurityView user={user} /></QueryClientProvider>);
  return client;
}

describe("AccountSecurityView", () => {
  beforeEach(() => {
    vi.mocked(getMfaStatus).mockResolvedValue({ enabled: false, enabledAt: null });
    vi.mocked(listAuthSessions).mockResolvedValue({ sessions });
    vi.mocked(revokeAuthSession).mockResolvedValue({ ok: true });
    vi.mocked(revokeOtherAuthSessions).mockResolvedValue({ ok: true, revokedSessionCount: 1 });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("비밀번호 변경을 유지하고 MFA·활성 세션 상태를 실제 API로 불러온다", async () => {
    renderView();

    expect(screen.getByRole("heading", { name: "계정 보안" })).toBeInTheDocument();
    expect(screen.getByLabelText("현재 비밀번호")).toBeInTheDocument();
    expect(await screen.findByText("2단계 인증이 꺼져 있습니다.")).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "활성 세션" });
    expect(within(list).getByText("현재 세션")).toBeInTheDocument();
    expect(within(list).getByText("Chrome on macOS")).toBeInTheDocument();
    expect(getMfaStatus).toHaveBeenCalledOnce();
    expect(listAuthSessions).toHaveBeenCalledOnce();
  });

  it("MFA 등록 비밀키는 로컬에 한 번 보여주고 확인 뒤 복구 코드를 한 번만 표시한다", async () => {
    vi.mocked(startMfaEnrollment).mockResolvedValue({
      enrollmentToken: "enrollment-token",
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUri: "otpauth://totp/LED%20Control:admin_01?secret=JBSWY3DPEHPK3PXP",
      expiresAt: "2026-09-12T12:10:00.000Z"
    });
    vi.mocked(confirmMfaEnrollment).mockResolvedValue({
      mfaEnabled: true,
      recoveryCodes: ["recovery-one", "recovery-two"]
    });
    const client = renderView();
    fireEvent.click(await screen.findByRole("button", { name: "2단계 인증 설정" }));

    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("인증 앱 코드"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 완료" }));

    expect(await screen.findByText("recovery-one")).toBeInTheDocument();
    expect(confirmMfaEnrollment).toHaveBeenCalledWith({ enrollmentToken: "enrollment-token", code: "123456" });
    expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain("JBSWY3DPEHPK3PXP");
    expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain("recovery-one");
    fireEvent.click(screen.getByRole("button", { name: "복구 코드를 안전하게 보관했습니다" }));
    expect(screen.queryByText("recovery-one")).not.toBeInTheDocument();
  });

  it("MFA 해제는 현재 비밀번호와 TOTP 또는 복구 코드를 전송한다", async () => {
    vi.mocked(getMfaStatus).mockResolvedValue({ enabled: true, enabledAt: "2026-09-10T10:00:00.000Z" });
    vi.mocked(disableMfa).mockResolvedValue({ mfaEnabled: false });
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "2단계 인증 해제" }));
    fireEvent.change(screen.getByLabelText("MFA 해제용 현재 비밀번호"), { target: { value: "current-password" } });
    fireEvent.change(screen.getByLabelText("MFA 해제용 인증 앱 코드"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "해제 확인" }));

    await waitFor(() => expect(disableMfa).toHaveBeenCalledWith({ currentPassword: "current-password", code: "654321" }));
  });

  it("다른 세션 전체 종료와 개별 종료를 반영한다", async () => {
    renderView();
    const list = await screen.findByRole("list", { name: "활성 세션" });

    fireEvent.click(within(list).getByRole("button", { name: "이 세션 종료" }));
    await waitFor(() => expect(revokeAuthSession).toHaveBeenCalledWith("session-other"));

    cleanup();
    renderView();
    await screen.findByRole("list", { name: "활성 세션" });
    fireEvent.click(screen.getByRole("button", { name: "다른 세션 모두 종료" }));
    await waitFor(() => expect(revokeOtherAuthSessions).toHaveBeenCalledOnce());
    expect(await screen.findByRole("status")).toHaveTextContent("다른 세션 1개를 종료했습니다.");
  });

  it("viewer에게는 MFA를 노출하거나 호출하지 않고 비밀번호와 세션만 제공한다", async () => {
    renderView(viewer);

    expect(await screen.findByRole("list", { name: "활성 세션" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "2단계 인증" })).not.toBeInTheDocument();
    expect(getMfaStatus).not.toHaveBeenCalled();
  });

  it("상태 조회 실패는 재시도 가능한 접근성 오류로 표시한다", async () => {
    vi.mocked(getMfaStatus).mockRejectedValue(new Error("offline"));
    vi.mocked(listAuthSessions).mockRejectedValue(new Error("offline"));
    renderView();

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    const alerts = screen.getAllByRole("alert");
    expect(alerts.some((alert) => alert.textContent?.includes("2단계 인증 상태를 불러오지 못했습니다."))).toBe(true);
    expect(alerts.some((alert) => alert.textContent?.includes("활성 세션을 불러오지 못했습니다."))).toBe(true);
    expect(screen.getAllByRole("button", { name: "다시 시도" })).toHaveLength(2);
  });

  it("principal 전환 시 이전 계정 MFA와 세션 query를 새 계정 화면에 재사용하지 않는다", async () => {
    vi.mocked(getMfaStatus)
      .mockResolvedValueOnce({ enabled: true, enabledAt: "2026-09-10T10:00:00.000Z" })
      .mockResolvedValueOnce({ enabled: false, enabledAt: null });
    vi.mocked(listAuthSessions)
      .mockResolvedValueOnce({ sessions })
      .mockResolvedValueOnce({ sessions: [{ ...sessions[0], id: "new-current", userAgent: "Safari new account" }] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(authMeQueryKey, { user: admin });
    const view = render(
      <QueryClientProvider client={client}><AccountSecurityView user={admin} /></QueryClientProvider>
    );
    expect(await screen.findByText("2단계 인증이 켜져 있습니다.")).toBeInTheDocument();
    expect(await screen.findByText("Chrome on macOS")).toBeInTheDocument();

    client.setQueryData(authMeQueryKey, { user: otherAdmin });
    view.rerender(<QueryClientProvider client={client}><AccountSecurityView user={otherAdmin} /></QueryClientProvider>);

    expect(await screen.findByText("2단계 인증이 꺼져 있습니다.")).toBeInTheDocument();
    expect(await screen.findByText("Safari new account")).toBeInTheDocument();
    expect(screen.queryByText("Chrome on macOS")).not.toBeInTheDocument();
    expect(client.getQueryData(["auth", "mfa", "admin-1:customer-1"])).toEqual({ enabled: true, enabledAt: "2026-09-10T10:00:00.000Z" });
    expect(client.getQueryData(["auth", "mfa", "admin-2:customer-2"])).toEqual({ enabled: false, enabledAt: null });
  });

  it("StrictMode effect 재설정 뒤에도 MFA 등록 응답을 현재 화면에 적용한다", async () => {
    vi.mocked(startMfaEnrollment).mockResolvedValue({
      enrollmentToken: "strict-enrollment",
      secret: "STRICTMODESECRET",
      otpauthUri: "otpauth://strict",
      expiresAt: "2026-09-12T12:10:00.000Z"
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(authMeQueryKey, { user: admin });
    render(
      <StrictMode>
        <QueryClientProvider client={client}><AccountSecurityView user={admin} /></QueryClientProvider>
      </StrictMode>
    );

    fireEvent.click(await screen.findByRole("button", { name: "2단계 인증 설정" }));
    expect(await screen.findByText("STRICTMODESECRET")).toBeInTheDocument();
  });

  it("이전 principal의 지연된 세션 종료 응답이 새 principal 인증 cache를 지우지 않는다", async () => {
    let finishRevocation: (() => void) | undefined;
    vi.mocked(revokeAuthSession).mockImplementation(() => new Promise((resolve) => {
      finishRevocation = () => resolve({ ok: true });
    }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(authMeQueryKey, { user: admin });
    const view = render(
      <QueryClientProvider client={client}><AccountSecurityView user={admin} /></QueryClientProvider>
    );
    await screen.findByRole("list", { name: "활성 세션" });
    fireEvent.click(screen.getByRole("button", { name: "현재 세션 종료" }));

    client.setQueryData(authMeQueryKey, { user: otherAdmin });
    view.rerender(<QueryClientProvider client={client}><AccountSecurityView user={otherAdmin} /></QueryClientProvider>);
    finishRevocation?.();

    await waitFor(() => expect(client.getQueryData(authMeQueryKey)).toEqual({ user: otherAdmin }));
    expect(confirm).toHaveBeenCalledOnce();
  });
});
