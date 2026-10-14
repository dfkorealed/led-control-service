import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { apiGet } from "../../api/client";
import { mockDashboard } from "../../test/fixtures";
import { CustomerShell } from "./CustomerShell";

vi.mock("../../api/client", async original => ({ ...await original<typeof import("../../api/client")>(), apiGet: vi.fn() }));
afterEach(() => { cleanup(); onlineManager.setOnline(true); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function VisitNewSite() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate("/settings?siteId=site-b")}>다른 현장 방문</button>;
}

it("keeps cached site context but announces a newly visited offline dashboard without animation", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const user = { id: "admin", organizationId: "org", organizationType: "customer" as const, loginId: "admin", name: "관리자", role: "admin" as const, status: "active" as const, mustChangePassword: false };
  const siteA = { ...mockDashboard, site: { ...mockDashboard.site, id: "site-a", name: "기존 현장" }, capabilities: { read: true, control: true, manage: true, commission: true } };
  const siteB = { ...siteA, site: { ...siteA.site, id: "site-b", name: "새 현장" } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["sites"], [{ id: "site-a", name: "기존 현장", customerName: "고객" }, { id: "site-b", name: "새 현장", customerName: "고객" }]);
  client.setQueryData(["dashboard", "site-a"], siteA);
  client.setQueryData(["auth", "me"], { user });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(apiGet).mockImplementation(async path => {
    if (path === "/sites/site-b/dashboard") { await pending; return siteB; }
    if (path === "/sites/site-a/dashboard") return siteA;
    if (path.includes("monitoring-incidents")) return { incidents: [], activeCount: 0, unreadCount: 0, nextCursor: null };
    return { users: [], count: 0, limit: 100 };
  });
  try {
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/settings?siteId=site-a"]}><CustomerShell user={user} /><VisitNewSite /></MemoryRouter></QueryClientProvider>);
    const summary = screen.getByRole("region", { name: "현장 전체" });
    expect(summary).toHaveTextContent("전체");
    act(() => onlineManager.setOnline(false));
    fireEvent.click(screen.getByRole("button", { name: "다른 현장 방문" }));
    await waitFor(() => expect(client.getQueryState(["dashboard", "site-b"])?.fetchStatus).toBe("paused"));
    expect(vi.mocked(apiGet).mock.calls.filter(([path]) => path === "/sites/site-b/dashboard")).toHaveLength(0);
    const waiting = within(summary).getByRole("status");
    expect(waiting).toHaveTextContent("네트워크 연결을 기다리고 있습니다.");
    expect(waiting).not.toHaveAttribute("aria-busy", "true");
    expect(waiting.querySelector("svg")).toBeNull();
    await act(async () => onlineManager.setOnline(true));
    await waitFor(() => expect(within(summary).getByRole("status")).toHaveTextContent("현장 집계 확인 중"));
    expect(within(summary).getByRole("status").querySelector("svg")).toHaveClass("animate-spin");
    await act(async () => release());
    await waitFor(() => expect(summary).toHaveTextContent("전체"));
    expect(within(summary).queryByRole("status")).toBeNull();
  } finally {
    release(); cleanup(); client.clear(); onlineManager.setOnline(true);
  }
});
