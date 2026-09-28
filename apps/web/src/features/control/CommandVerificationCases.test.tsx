import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandVerificationCases } from "./CommandVerificationCases";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

const caseRecord = {
  caseId: "case-1", originalCommandId: "old-1", siteId: "site-1", targetCount: 2,
  verificationAttemptCount: 1, status: "verification_required", canRequestStatusCheck: true,
  lastCheckedAt: null, reasonCode: "outcome_unknown"
};

function renderCases(canControl = true, canManage = false, recentCaseId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CommandVerificationCases open userId="user-1" siteId="site-1" canControl={canControl} canManage={canManage} recentCaseId={recentCaseId} onClose={vi.fn()} /></QueryClientProvider>);
  return client;
}

describe("CommandVerificationCases", () => {
  it.each([
    ["verified_applied", "적용됨"], ["verified_not_applied", "미적용"], ["verified_partial", "일부 적용"]
  ])("shows a minimal terminal %s case without Set or risk actions", async (status, label) => {
    const fetch = vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith("/case-1")
      ? { caseId: "case-1", siteId: "site-1", status, targetCount: 2, resolvedAt: "2026-09-25T00:00:00.000Z" }
      : { items: [], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" } }));
    vi.stubGlobal("fetch", fetch);
    renderCases(true, true, "case-1");
    const drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(drawer).findByRole("button", { name: "최근 확인 결과 보기" }));
    expect(await within(drawer).findByText(new RegExp(`실제 상태 확인: ${label}`))).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "위험 승인" })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "실제 상태 확인 요청" })).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/fixture-1/)).not.toBeInTheDocument();
    expect(fetch.mock.calls.every(([, init]) => !init.method || init.method === "GET")).toBe(true);
  });
  it("explains unavailable server actions and sends no POST even for managers", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith("/case-1")
      ? { ...caseRecord, targetFixtureIds: ["fixture-1"] }
      : { items: [caseRecord], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" } }));
    vi.stubGlobal("fetch", fetch);
    renderCases(true, true);
    const drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(drawer).findByRole("button", { name: /old-1/ }));
    const check = await within(drawer).findByRole("button", { name: "실제 상태 확인 요청" });
    const risk = within(drawer).getByRole("button", { name: "위험 승인" });
    expect(check).toBeDisabled();
    expect(risk).toBeDisabled();
    expect(within(drawer).getByText(/서버 기능 준비 전/)).toBeInTheDocument();
    fireEvent.click(check); fireEvent.click(risk);
    expect(screen.queryByRole("dialog", { name: "확인 불가 명령 위험 승인" })).not.toBeInTheDocument();
    expect(fetch.mock.calls.every(([, init]) => !init.method || init.method === "GET")).toBe(true);
  });

  it.each([401, 403, 404, 410, 500])("hides cached targets during refetch and after %s", async (status) => {
    let finish: (value: unknown) => void = () => undefined;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/case-1")) {
        if (++reads > 1) return new Promise((resolve) => { finish = resolve; });
        return { ok: true, json: async () => ({ ...caseRecord, targetFixtureIds: ["private-target"] }) };
      }
      return { ok: true, json: async () => ({ items: [caseRecord], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" }) };
    }));
    const client = renderCases(true, true);
    const drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(drawer).findByRole("button", { name: /old-1/ }));
    expect(await within(drawer).findByText(/private-target/)).toBeInTheDocument();
    const pending = client.invalidateQueries({ queryKey: ["command-verification-case"] });
    await waitFor(() => expect(within(drawer).queryByText(/private-target/)).not.toBeInTheDocument());
    finish({ ok: false, status, headers: { get: () => "application/json" }, json: async () => ({ code: "unavailable" }) });
    await pending;
    expect(within(drawer).queryByText(/private-target/)).not.toBeInTheDocument();
  });

  it("ignores an old site's delayed cursor completion after switching scope", async () => {
    let finishOldPage: (value: unknown) => void = () => undefined;
    const otherCase = { ...caseRecord, caseId: "case-2", originalCommandId: "old-2", siteId: "site-2" };
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("cursor=old-cursor")) return new Promise((resolve) => { finishOldPage = resolve; });
      return { ok: true, json: async () => ({
        items: [url.includes("siteId=site-2") ? otherCase : caseRecord],
        nextCursor: url.includes("siteId=site-2") ? null : "old-cursor",
        generatedAt: "2026-09-25T00:00:00.000Z"
      }) };
    });
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (userId: string, siteId: string) => <QueryClientProvider client={client}><CommandVerificationCases open userId={userId} siteId={siteId} canControl canManage={false} onClose={vi.fn()} /></QueryClientProvider>;
    const { rerender } = render(view("user-1", "site-1"));
    let drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    const next = within(drawer).getByRole("button", { name: "다음" });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    rerender(view("user-2", "site-2"));
    drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    expect(await within(drawer).findByRole("button", { name: /old-2/ })).toBeInTheDocument();
    finishOldPage({ ok: true, json: async () => ({ items: [caseRecord], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" }) });
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "다음" })).toBeDisabled());
    expect(within(drawer).getByRole("button", { name: /old-2/ })).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /old-1/ })).not.toBeInTheDocument();
  });

  it("moves keyboard focus to the enabled previous button on the last case page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => ({
      items: [url.includes("cursor=") ? { ...caseRecord, caseId: "case-2", originalCommandId: "old-2" } : caseRecord],
      nextCursor: url.includes("cursor=") ? null : "next-cursor", generatedAt: "2026-09-25T00:00:00.000Z"
    }) })));
    renderCases();
    const drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    const next = within(drawer).getByRole("button", { name: "다음" });
    await waitFor(() => expect(next).toBeEnabled());
    next.focus();
    fireEvent.click(next);
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "이전" })).toHaveFocus());
    expect(next).toBeDisabled();
  });
});
