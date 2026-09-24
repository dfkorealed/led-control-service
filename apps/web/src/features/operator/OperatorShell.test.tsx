import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../api/auth";
import { apiGet, apiPost } from "../../api/client";
import { authMeQueryKey } from "../../api/principal-cache";
import { OperatorShell } from "./OperatorShell";

vi.mock("../../api/client", async (original) => ({
  ...await original<typeof import("../../api/client")>(),
  apiGet: vi.fn(),
  apiPost: vi.fn()
}));

const operator: AuthUser = {
  id: "operator-1", organizationId: "provider-1", organizationType: "service_provider",
  loginId: "service_operator", name: "운영자", role: "operator", status: "active", mustChangePassword: false
};

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="현재 경로">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function renderShell(path = "/operator/site-admins") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(authMeQueryKey, { user: operator });
  client.setQueryData(["tenant", "private"], { siteId: "site-1" });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <OperatorShell user={operator} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return client;
}

describe("operator shell route boundary", () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset().mockImplementation((path: string) => {
      if (path === "/auth/mfa") return Promise.resolve({ enabled: false, enabledAt: null });
      if (path === "/auth/sessions") return Promise.resolve({ sessions: [] });
      return Promise.resolve([]);
    });
    vi.mocked(apiPost).mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(cleanup);

  it("keeps the operator header usable during route loading and renders the real management view", async () => {
    renderShell("/operator/site-admins?source=direct#accounts");

    expect(within(screen.getByRole("main")).getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("service_operator")).toBeVisible();
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeEnabled();
    expect(await screen.findByRole("heading", { name: "현장 관리자 계정" }, { timeout: 5_000 })).toBeVisible();
    expect(await screen.findByText("관리할 현장이 없습니다.")).toBeVisible();
    expect(screen.getByLabelText("현재 경로")).toHaveTextContent("/operator/site-admins?source=direct#accounts");
  });

  it("운영자 헤더에 킨다 서비스 운영 브랜드를 표시한다", async () => {
    renderShell();

    expect(screen.getByRole("img", { name: "킨다 서비스 운영" })).toBeVisible();
    expect(screen.queryByText(/LED\s+Control/)).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
  });

  it("redirects an unknown direct URL to site admin management", async () => {
    renderShell("/monitoring?siteId=site-1#floor");

    expect(await screen.findByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
    expect(screen.getByLabelText("현재 경로")).toHaveTextContent(/^\/operator\/site-admins$/);
  });

  it("keeps site admin management and exposes the reusable account security route", async () => {
    renderShell("/operator/security?source=account#sessions");

    expect(screen.getByRole("navigation", { name: "운영자 메뉴" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "현장 관리자" })).toHaveAttribute("href", "/operator/site-admins?source=account#sessions");
    expect(screen.getByRole("link", { name: "계정 보안" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("heading", { name: "계정 보안" })).toBeVisible();
    expect(screen.getByLabelText("현재 비밀번호")).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith("/auth/mfa");
    expect(apiGet).toHaveBeenCalledWith("/auth/sessions");
  });

  it("clears authentication and tenant cache after logout", async () => {
    const client = renderShell();
    await screen.findByText("관리할 현장이 없습니다.");
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));

    await waitFor(() => expect(client.getQueryData(authMeQueryKey)).toBeNull());
    expect(client.getQueryData(["tenant", "private"])).toBeUndefined();
    expect(apiPost).toHaveBeenCalledWith("/auth/logout", {}, { timeoutMs: 8_000 });
  });

  it("keeps authentication and enables retry after logout fails", async () => {
    vi.mocked(apiPost).mockRejectedValueOnce(new Error("offline"));
    const client = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("로그아웃에 실패했습니다.");
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeEnabled();
    expect(client.getQueryData(authMeQueryKey)).toEqual({ user: operator });
    expect(client.getQueryData(["tenant", "private"])).toEqual({ siteId: "site-1" });
  });
});
