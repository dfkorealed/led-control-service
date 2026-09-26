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
  it("reads the separate scoped case list and detail with no control POST", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith("/case-1")
      ? { ...caseRecord, targetFixtureIds: ["fixture-1", "fixture-2"] }
      : { items: [caseRecord], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" } }));
    vi.stubGlobal("fetch", fetch);
    renderCases(false, false);
    const dialog = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /old-1/ }));
    expect(await within(dialog).findByText(/fixture-1/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "실제 상태 확인 요청" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "위험 승인" })).not.toBeInTheDocument();
    expect(fetch.mock.calls.every(([, init]) => !init.method || init.method === "GET")).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe("/api/commands/requiring-verification?siteId=site-1&limit=4");
  });

  it("uses only the case Get-only status-check endpoint and retries a lost reply with the same key", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/status-checks")) {
        if (fetch.mock.calls.filter(([path]) => String(path).endsWith("/status-checks")).length === 1) throw new TypeError("lost response");
        return { ok: true, json: async () => ({ caseId: "case-1", dispatchId: "dispatch-1", dispatchIds: ["dispatch-1"], verificationAttempt: 2, terminalStatusUrl: "/commands/requiring-verification/case-1" }) };
      }
      return { ok: true, json: async () => url.endsWith("/case-1")
        ? { ...caseRecord, targetFixtureIds: ["fixture-1", "fixture-2"] }
        : { items: [caseRecord], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" } };
    });
    vi.stubGlobal("fetch", fetch);
    renderCases(true, false);
    const dialog = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /old-1/ }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "실제 상태 확인 요청" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "동일 상태 확인 요청 재시도" }));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/status-checks"))).toHaveLength(2));
    const posts = fetch.mock.calls.filter(([url]) => String(url).endsWith("/status-checks"));
    expect(JSON.parse(posts[0][1].body)).toEqual(JSON.parse(posts[1][1].body));
    expect(posts.every(([url]) => String(url) === "/api/commands/requiring-verification/case-1/status-checks")).toBe(true);
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/commands/dimming"))).toBe(false);
  });

  it("uses the same status-check request ID after an unmount and reload", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/status-checks")) {
        if (fetch.mock.calls.filter(([path]) => String(path).endsWith("/status-checks")).length === 1) throw new TypeError("lost reply");
        return { ok: true, json: async () => ({ caseId: "case-1", dispatchId: "dispatch-1", dispatchIds: ["dispatch-1"], verificationAttempt: 2, terminalStatusUrl: "/commands/requiring-verification/case-1" }) };
      }
      return { ok: true, json: async () => url.endsWith("/case-1")
        ? { ...caseRecord, targetFixtureIds: ["fixture-1"] }
        : { items: [caseRecord], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" } };
    });
    vi.stubGlobal("fetch", fetch);
    renderCases();
    let drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(drawer).findByRole("button", { name: /old-1/ }));
    fireEvent.click(await within(drawer).findByRole("button", { name: "실제 상태 확인 요청" }));
    expect(await within(drawer).findByRole("button", { name: "동일 상태 확인 요청 재시도" })).toBeInTheDocument();
    cleanup();
    renderCases();
    drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(drawer).findByRole("button", { name: /old-1/ }));
    fireEvent.click(await within(drawer).findByRole("button", { name: "동일 상태 확인 요청 재시도" }));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/status-checks"))).toHaveLength(2));
    const posts = fetch.mock.calls.filter(([url]) => String(url).endsWith("/status-checks"));
    expect(JSON.parse(posts[1][1].body)).toEqual(JSON.parse(posts[0][1].body));
  });

  it("hides cached case details and approval when a background read loses authorization", async () => {
    let detailReads = 0;
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/case-1")) {
        detailReads += 1;
        return detailReads === 1
          ? { ok: true, json: async () => ({ ...caseRecord, targetFixtureIds: ["fixture-1"] }) }
          : { ok: false, status: 401, headers: { get: () => "application/json" }, json: async () => ({ code: "unauthorized" }) };
      }
      return { ok: true, json: async () => ({ items: [caseRecord], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" }) };
    });
    vi.stubGlobal("fetch", fetch);
    const client = renderCases(true, true);
    const drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(drawer).findByRole("button", { name: /old-1/ }));
    fireEvent.click(await within(drawer).findByRole("button", { name: "위험 승인" }));
    expect(screen.getByRole("dialog", { name: "확인 불가 명령 위험 승인" })).toBeInTheDocument();
    await client.invalidateQueries({ queryKey: ["command-verification-case", "user-1", "site-1", "case-1"] });
    await waitFor(() => expect(detailReads).toBe(2));
    expect(within(drawer).queryByText(/fixture-1/)).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /old-1/ })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "실제 상태 확인 요청" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "확인 불가 명령 위험 승인" })).not.toBeInTheDocument();
  });

  it("hides cached case rows after a background list 401", async () => {
    let listReads = 0;
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/case-1")) return { ok: true, json: async () => ({ ...caseRecord, targetFixtureIds: ["fixture-1"] }) };
      listReads += 1;
      return listReads === 1
        ? { ok: true, json: async () => ({ items: [caseRecord], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" }) }
        : { ok: false, status: 401, headers: { get: () => "application/json" }, json: async () => ({ code: "unauthorized" }) };
    });
    vi.stubGlobal("fetch", fetch);
    const client = renderCases(true, true);
    const drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(drawer).findByRole("button", { name: /old-1/ }));
    expect(await within(drawer).findByText(/fixture-1/)).toBeInTheDocument();
    await client.invalidateQueries({ queryKey: ["command-verification-cases", "user-1"] });
    await waitFor(() => expect(listReads).toBe(2));
    expect(within(drawer).queryByRole("button", { name: /old-1/ })).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/fixture-1/)).not.toBeInTheDocument();
    expect(within(drawer).getByRole("alert")).toHaveTextContent("조회 권한이 변경되었습니다");
  });

  it("shows manage risk approval only to managers and sends no command on opening", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith("/case-1")
      ? { ...caseRecord, targetFixtureIds: ["fixture-1", "fixture-2"] }
      : { items: [caseRecord], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" } }));
    vi.stubGlobal("fetch", fetch);
    renderCases(true, true);
    const dialog = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /old-1/ }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "위험 승인" }));
    expect(screen.getByRole("dialog", { name: "확인 불가 명령 위험 승인" })).toBeInTheDocument();
    expect(fetch.mock.calls.every(([, init]) => !init.method || init.method === "GET")).toBe(true);
  });

  it.each(["status_check_attempts_exhausted", "status_check_in_progress", "verification_case_not_found"])("keeps the case visible and blocks a new Get after %s", async (code) => {
    const fetch = vi.fn().mockImplementation(async (url: string) => url.endsWith("/status-checks")
      ? { ok: false, status: code === "verification_case_not_found" ? 404 : 409, headers: { get: () => "application/json" }, json: async () => ({ code }) }
      : { ok: true, json: async () => url.endsWith("/case-1")
        ? { ...caseRecord, targetFixtureIds: ["fixture-1"] }
        : { items: [caseRecord], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" } });
    vi.stubGlobal("fetch", fetch);
    renderCases(true, false);
    const dialog = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /old-1/ }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "실제 상태 확인 요청" }));
    expect(await within(dialog).findByText(/제어 잠금은 유지됩니다/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /old-1/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "실제 상태 확인 요청" })).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/status-checks"))).toHaveLength(1);
  });

  it("allows another Get only after a fresh detail confirms the case can be checked", async () => {
    let detailReads = 0;
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/status-checks")) return { ok: false, status: 409, headers: { get: () => "application/json" }, json: async () => ({ code: "status_check_in_progress" }) };
      if (url.endsWith("/case-1")) {
        detailReads += 1;
        return { ok: true, json: async () => ({ ...caseRecord, targetFixtureIds: ["fixture-1"] }) };
      }
      return { ok: true, json: async () => ({ items: [caseRecord], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" }) };
    });
    vi.stubGlobal("fetch", fetch);
    renderCases();
    const drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(drawer).findByRole("button", { name: /old-1/ }));
    fireEvent.click(await within(drawer).findByRole("button", { name: "실제 상태 확인 요청" }));
    expect(await within(drawer).findByRole("button", { name: "case 다시 조회" })).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "실제 상태 확인 요청" })).not.toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "case 다시 조회" }));
    await waitFor(() => expect(detailReads).toBe(2));
    expect(await within(drawer).findByRole("button", { name: "실제 상태 확인 요청" })).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/status-checks"))).toHaveLength(1);
  });

  it("keeps the case and warning after the reconcile audit POST fails", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => url.endsWith("/reconcile")
      ? { ok: false, status: 500, headers: { get: () => "application/json" }, json: async () => ({ code: "audit_failed" }) }
      : { ok: true, json: async () => url.endsWith("/case-1")
        ? { ...caseRecord, targetFixtureIds: ["fixture-1"] }
        : { items: [caseRecord], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" } });
    vi.stubGlobal("fetch", fetch);
    renderCases(true, true);
    const drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(drawer).findByRole("button", { name: /old-1/ }));
    fireEvent.click(await within(drawer).findByRole("button", { name: "위험 승인" }));
    fireEvent.click(screen.getByRole("radio", { name: "물리 상태 확인 완료" }));
    fireEvent.change(screen.getByRole("textbox", { name: "승인 사유" }), { target: { value: "현장 확인" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /위험을 이해하고 승인/ }));
    fireEvent.click(screen.getByRole("button", { name: "위험 승인 및 차단 해제" }));
    expect(await screen.findByText(/잠금은 유지됩니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(within(drawer).getByRole("button", { name: /old-1/ })).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/reconcile"))).toHaveLength(1);
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/commands/dimming"))).toBe(false);
  });

  it("drops an old site's delayed Get response after switching user and site", async () => {
    let finishOldCheck: (value: unknown) => void = () => undefined;
    const otherCase = { ...caseRecord, caseId: "case-2", originalCommandId: "old-2", siteId: "site-2" };
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/case-1/status-checks")) return new Promise((resolve) => { finishOldCheck = resolve; });
      if (url.endsWith("/case-1")) return { ok: true, json: async () => ({ ...caseRecord, targetFixtureIds: ["fixture-1"] }) };
      if (url.endsWith("/case-2")) return { ok: true, json: async () => ({ ...otherCase, targetFixtureIds: ["fixture-2"] }) };
      return { ok: true, json: async () => ({ items: [url.includes("siteId=site-2") ? otherCase : caseRecord], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" }) };
    });
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (userId: string, siteId: string) => <QueryClientProvider client={client}><CommandVerificationCases open userId={userId} siteId={siteId} canControl canManage={false} onClose={vi.fn()} /></QueryClientProvider>;
    const { rerender } = render(view("user-1", "site-1"));
    let drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    fireEvent.click(await within(drawer).findByRole("button", { name: /old-1/ }));
    fireEvent.click(await within(drawer).findByRole("button", { name: "실제 상태 확인 요청" }));
    rerender(view("user-2", "site-2"));
    drawer = screen.getByRole("dialog", { name: "확인 필요한 명령" });
    expect(await within(drawer).findByRole("button", { name: /old-2/ })).toBeInTheDocument();
    finishOldCheck({ ok: true, json: async () => ({ caseId: "case-1", dispatchId: "dispatch-1", dispatchIds: ["dispatch-1"], verificationAttempt: 2, terminalStatusUrl: "/commands/requiring-verification/case-1" }) });
    await waitFor(() => expect(within(drawer).queryByRole("button", { name: /old-1/ })).not.toBeInTheDocument());
    expect(within(drawer).queryByText(/실제 상태 확인을 요청했습니다/)).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/status-checks"))).toHaveLength(1);
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
