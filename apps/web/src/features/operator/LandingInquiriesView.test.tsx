import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../api/auth";
import { apiGet, apiPost } from "../../api/client";
import { requestLandingMailAuthorization } from "../../api/landing-inquiries";
import { OperatorShell } from "./OperatorShell";

vi.mock("../../api/client", async (original) => ({
  ...await original<typeof import("../../api/client")>(),
  apiGet: vi.fn(),
  apiPost: vi.fn()
}));

const operator: AuthUser = {
  id: "operator-1", organizationId: "provider-1", organizationType: "service_provider",
  loginId: "operator_1", name: "운영자", role: "operator", status: "active", mustChangePassword: false
};

function PathProbe() {
  const location = useLocation();
  return <output aria-label="현재 경로">{location.pathname}</output>;
}

function renderRoute(user: AuthUser = operator) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/operator/landing-inquiries"]}>
    <OperatorShell user={user} /><PathProbe />
  </MemoryRouter></QueryClientProvider>);
}

const inquiry = (deliveryStatus: string, reference: string) => ({
  reference, companyName: "예시 시설", contactName: "담당자", email: "reply@example.com", phone: "",
  audience: "facility", message: "조명 문의", createdAt: "2026-09-25T00:00:00.000Z",
  expiresAt: "2026-12-24T00:00:00.000Z", deliveryStatus, attemptCount: 1,
  lastErrorCode: null, providerAcceptedAt: deliveryStatus === "provider_accepted" ? "2026-09-25T00:01:00.000Z" : null
});

describe("operator landing inquiries route", () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset().mockImplementation((path: string) => {
      if (path === "/operator/landing-mail/status") return Promise.resolve({ connected: false });
      if (path === "/operator/landing-inquiries?limit=20") return Promise.resolve({
        items: [
          inquiry("queued", "K-QUEUED"), inquiry("retry_wait", "K-RETRY"),
          inquiry("provider_accepted", "K-ACCEPTED"), inquiry("delivery_uncertain", "K-UNCERTAIN"),
          inquiry("failed", "K-FAILED")
        ], nextCursor: null
      });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.mocked(apiPost).mockReset();
  });
  afterEach(cleanup);

  it("opens the protected inquiry route from the operator menu and explains all delivery states", async () => {
    renderRoute();

    expect(screen.getByRole("link", { name: "상담 문의" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("heading", { name: "상담 문의 관리" })).toBeVisible();
    expect(await screen.findByText("K-QUEUED")).toBeVisible();
    for (const reference of ["K-QUEUED", "K-RETRY", "K-ACCEPTED", "K-UNCERTAIN", "K-FAILED"]) {
      expect(screen.getByText(reference)).toBeVisible();
    }
    for (const label of ["발송 대기", "재시도 대기", "제공자 수락", "수락 여부 불확실", "발송 실패"]) {
      expect(screen.getByText(label)).toBeVisible();
    }
    expect(screen.getByText(/받은편지함 도착을 뜻하지 않습니다/)).toBeVisible();
    expect(screen.getByText(/보낸메일.*접수번호/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /재발송/ })).not.toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith("/operator/landing-inquiries?limit=20");
    expect(apiGet).toHaveBeenCalledWith("/operator/landing-mail/status");
  });

  it.each(["admin", "viewer"] as const)("does not mount the operator route for a %s", async (role) => {
    renderRoute({ ...operator, role, organizationType: "customer" });

    await waitFor(() => expect(screen.getByLabelText("현재 경로")).toHaveTextContent("/monitoring"));
    expect(screen.queryByRole("heading", { name: "상담 문의 관리" })).not.toBeInTheDocument();
    expect(apiGet).not.toHaveBeenCalledWith("/operator/landing-inquiries?limit=20");
    expect(apiGet).not.toHaveBeenCalledWith("/operator/landing-mail/status");
  });

  it("requests a server authorization URL only when the connect button is pressed", async () => {
    renderRoute();
    expect(await screen.findByRole("button", { name: "NAVER WORKS 연결" })).toBeEnabled();
    expect(apiPost).not.toHaveBeenCalled();

    vi.mocked(apiPost).mockResolvedValue({ authorizationUrl: "https://evil.example/authorize" });
    fireEvent.click(screen.getByRole("button", { name: "NAVER WORKS 연결" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("연결을 시작하지 못했습니다");
    expect(apiPost).toHaveBeenCalledWith("/operator/landing-mail/authorize", {});
  });

  it("allows navigation only to an official server-returned NAVER WORKS authorization URL", async () => {
    const navigate = vi.fn();
    const official = "https://auth.worksmobile.com/oauth2/v2.0/authorize?scope=mail&response_type=code&state=opaque";
    vi.mocked(apiPost).mockResolvedValueOnce({ authorizationUrl: official });
    await requestLandingMailAuthorization(navigate);
    expect(navigate).toHaveBeenCalledWith(official);

    for (const authorizationUrl of ["https://evil.example/authorize", "http://auth.worksmobile.com/oauth2/v2.0/authorize", "https://auth.worksmobile.com.evil.example/oauth2/v2.0/authorize"]) {
      vi.mocked(apiPost).mockResolvedValueOnce({ authorizationUrl });
      await expect(requestLandingMailAuthorization(navigate)).rejects.toThrow();
    }
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("uses the server cursor to page through at most 20 recent inquiries", async () => {
    vi.mocked(apiGet).mockImplementation((path: string) => {
      if (path === "/operator/landing-mail/status") return Promise.resolve({ connected: true });
      if (path === "/operator/landing-inquiries?limit=20") return Promise.resolve({ items: [inquiry("queued", "K-FIRST")], nextCursor: "opaque-cursor" });
      if (path === "/operator/landing-inquiries?limit=20&cursor=opaque-cursor") return Promise.resolve({ items: [inquiry("failed", "K-SECOND")], nextCursor: null });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    renderRoute();
    expect(await screen.findByText("K-FIRST")).toBeVisible();
    expect(screen.queryByRole("button", { name: "NAVER WORKS 연결" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다음 문의" }));
    expect(await screen.findByText("K-SECOND")).toBeVisible();
    expect(apiGet).toHaveBeenCalledWith("/operator/landing-inquiries?limit=20&cursor=opaque-cursor");
    fireEvent.click(screen.getByRole("button", { name: "이전 문의" }));
    expect(await screen.findByText("K-FIRST")).toBeVisible();
  });
});
