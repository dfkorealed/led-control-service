import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { completeMfaLogin, login, type AuthUser } from "../../api/auth";
import { AuthView } from "./AuthView";

vi.mock("../../api/auth", async (original) => ({
  ...await original<typeof import("../../api/auth")>(),
  login: vi.fn(),
  completeMfaLogin: vi.fn()
}));

const loginMock = vi.mocked(login);
const completeMfaLoginMock = vi.mocked(completeMfaLogin);
const admin: AuthUser = {
  id: "admin-1",
  organizationId: "customer-1",
  organizationType: "customer",
  loginId: "admin_01",
  name: "관리자",
  role: "admin",
  status: "active",
  mustChangePassword: false
};

function renderView(onAuthenticated = vi.fn().mockResolvedValue(undefined)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AuthView onAuthenticated={onAuthenticated} />
    </QueryClientProvider>
  );
  return { client, onAuthenticated };
}

function submitCredentials() {
  fireEvent.change(screen.getByLabelText("아이디"), { target: { value: " admin_01 " } });
  fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "correct-password" } });
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
}

describe("AuthView MFA login", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("킨다 브랜드와 한글 로그인 제목을 표시한다", () => {
    renderView();

    const introduction = screen.getByRole("region", { name: "킨다 소개" });
    expect(within(introduction).getByRole("img", { name: "킨다" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
    expect(screen.queryByText(/LED\s+Control/)).not.toBeInTheDocument();
  });

  it("일반 로그인 응답은 기존 인증 완료 흐름을 유지한다", async () => {
    loginMock.mockResolvedValue({ user: admin });
    const { onAuthenticated } = renderView();

    submitCredentials();

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith({ user: admin }));
    expect(completeMfaLoginMock).not.toHaveBeenCalled();
  });

  it("MFA challenge는 비밀번호를 지우고 TOTP 단계로 전환한다", async () => {
    loginMock.mockResolvedValue({
      mfaRequired: true,
      challengeToken: "challenge-secret",
      expiresAt: "2026-09-12T12:05:00.000Z"
    });
    const { client, onAuthenticated } = renderView();

    submitCredentials();

    expect(await screen.findByRole("heading", { name: "2단계 인증" })).toBeInTheDocument();
    expect(screen.getByLabelText("인증 앱 코드")).toHaveFocus();
    expect(screen.queryByLabelText("비밀번호")).not.toBeInTheDocument();
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain("correct-password");
    expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain("challenge-secret");
  });

  it("TOTP와 복구 코드 로그인을 각각 실제 MFA endpoint로 전송한다", async () => {
    loginMock.mockResolvedValue({
      mfaRequired: true,
      challengeToken: "challenge-token",
      expiresAt: "2026-09-12T12:05:00.000Z"
    });
    completeMfaLoginMock.mockResolvedValue({ user: admin, recoveryCodeUsed: false });
    const { onAuthenticated } = renderView();
    submitCredentials();
    await screen.findByRole("heading", { name: "2단계 인증" });

    fireEvent.change(screen.getByLabelText("인증 앱 코드"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "인증하고 로그인" }));

    await waitFor(() => expect(completeMfaLoginMock).toHaveBeenCalledWith({
      challengeToken: "challenge-token",
      code: "123456"
    }));
    expect(onAuthenticated).toHaveBeenCalledWith({ user: admin });

    cleanup();
    vi.clearAllMocks();
    loginMock.mockResolvedValue({
      mfaRequired: true,
      challengeToken: "recovery-challenge",
      expiresAt: "2026-09-12T12:05:00.000Z"
    });
    completeMfaLoginMock.mockResolvedValue({ user: admin, recoveryCodeUsed: true });
    renderView();
    submitCredentials();
    await screen.findByRole("heading", { name: "2단계 인증" });
    fireEvent.click(screen.getByRole("button", { name: "복구 코드 사용" }));
    fireEvent.change(screen.getByLabelText("복구 코드"), { target: { value: "one-time-recovery" } });
    fireEvent.click(screen.getByRole("button", { name: "인증하고 로그인" }));

    await waitFor(() => expect(completeMfaLoginMock).toHaveBeenCalledWith({
      challengeToken: "recovery-challenge",
      recoveryCode: "one-time-recovery"
    }));
  });

  it.each([
    [401, "아이디 또는 비밀번호를 확인해 주세요."],
    [429, "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요."],
    [503, "인증 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요."]
  ])("로그인 %i 오류를 구분해 접근성 알림으로 표시한다", async (status, message) => {
    loginMock.mockRejectedValue(new ApiError("failed", status, {}));
    renderView();
    submitCredentials();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("MFA 401은 소비된 challenge를 버리고 자격 증명 단계로 돌아간다", async () => {
    loginMock.mockResolvedValue({
      mfaRequired: true,
      challengeToken: "challenge-token",
      expiresAt: "2026-09-12T12:05:00.000Z"
    });
    completeMfaLoginMock.mockRejectedValue(new ApiError("failed", 401, { code: "MFA_INVALID" }));
    renderView();
    submitCredentials();
    await screen.findByRole("heading", { name: "2단계 인증" });
    fireEvent.change(screen.getByLabelText("인증 앱 코드"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "인증하고 로그인" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("인증 코드가 올바르지 않거나 만료되었습니다. 아이디와 비밀번호부터 다시 입력해 주세요.");
    expect(screen.getByLabelText("비밀번호")).toHaveValue("");
    expect(screen.queryByLabelText("인증 앱 코드")).not.toBeInTheDocument();
  });
});
