import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandHistoryPanel } from "./CommandHistoryPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHistory(onSelect = vi.fn(), compactDisclosure = false, onOpenVerificationCases?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CommandHistoryPanel userId="user" siteId="site" onSelect={onSelect} compactDisclosure={compactDisclosure} onOpenVerificationCases={onOpenVerificationCases} /></QueryClientProvider>);
  return { onSelect, client };
}

function command(id: string) {
  return { id, stage: "verification_required", outcome: "unknown", brightness: 70, totalFixtureCount: 2, completedFixtureCount: 2, createdAt: "2026-09-12T01:00:00.000Z", dispatchCount: 1, errorMessage: null, verificationAttemptCount: 0 };
}

describe("CommandHistoryPanel", () => {
  it("preserves partial date draft across filter close", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: false, items: [], nextCursor: null }) });
    vi.stubGlobal("fetch", fetch); renderHistory();
    fireEvent.click(screen.getByRole("button", { name: "명령 이력 열기" }));
    await within(screen.getByRole("dialog", { name: "명령 이력" })).findByText("명령 이력이 없습니다.");
    expect(screen.queryByRole("group", { name: "조회 기간" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /명령 이력 필터 상세 필터/ }));
    const year = screen.getAllByRole("spinbutton")[0];
    fireEvent.keyDown(year, { key: "ArrowUp" });
    const raw = year.textContent;
    const requests = fetch.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: /명령 이력 필터 상세 필터/ }));
    expect(screen.getAllByRole("spinbutton")[0]).toHaveTextContent(raw!);
    expect(screen.getByRole("group", { name: "조회 기간" })).toHaveAccessibleDescription(/시작일과 종료일을 올바른 순서로 완성해 주세요/);
    expect(fetch.mock.calls.length).toBe(requests);
    fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect(screen.getAllByRole("spinbutton")[0]).not.toHaveTextContent(raw!);
  });

  it("keeps a stable unknown pager during an initial full-history read", async () => {
    let release!: (value: unknown) => void;
    const fetch = vi.fn().mockImplementation((url: string) => url.includes("limit=1")
      ? Promise.resolve({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00Z", retentionEnabled: false, items: [], nextCursor: null }) })
      : new Promise(resolve => { release = resolve; }));
    vi.stubGlobal("fetch", fetch); renderHistory();
    fireEvent.click(screen.getByRole("button", { name: "명령 이력 열기" }));
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    const pager = within(drawer).getByRole("navigation", { name: "페이지 이동" });
    expect(within(pager).queryByRole("button", { name: "페이지당 항목 수" })).not.toBeInTheDocument();
    openHistoryFilters();
    expect(screen.getByRole("button", { name: "페이지당 항목 수" })).toHaveTextContent("50개");
    expect(pager).not.toHaveTextContent("현재 0건");
    expect(screen.getByRole("group", { name: "조회 기간" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    release({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00Z", retentionEnabled: false, items: [], nextCursor: null }) });
    await waitFor(() => expect(pager).toHaveTextContent("현재 0건"));
    expect(within(drawer).getByRole("navigation", { name: "페이지 이동" })).toBe(pager);
  });

  it("discards navigation on A2→B1→A1 and close/reopen", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      return { ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: false,
        items: [command(`${params.get("siteId")}-${params.has("cursor") ? "second" : "first"}`)],
        nextCursor: params.has("cursor") ? null : "next" }) };
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const element = (siteId: string) => <QueryClientProvider client={client}><CommandHistoryPanel userId="user" siteId={siteId} onSelect={vi.fn()} /></QueryClientProvider>;
    const view = render(element("A"));
    fireEvent.click(screen.getByRole("button", { name: "명령 이력 열기" }));
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    await within(drawer).findByRole("button", { name: /A-first/ });
    fireEvent.click(within(drawer).getByRole("button", { name: "다음 페이지" }));
    await within(drawer).findByRole("button", { name: /A-second/ });
    view.rerender(element("B"));
    expect(within(drawer).queryByRole("button", { name: /A-second/ })).not.toBeInTheDocument();
    await within(drawer).findByRole("button", { name: /B-first/ });
    view.rerender(element("A"));
    expect(within(drawer).queryByRole("button", { name: /A-second/ })).not.toBeInTheDocument();
    await within(drawer).findByRole("button", { name: /A-first/ });
    fireEvent.click(within(drawer).getByRole("button", { name: "다음 페이지" }));
    await within(drawer).findByRole("button", { name: /A-second/ });
    fireEvent.click(within(drawer).getByRole("button", { name: "명령 이력 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: "명령 이력 열기" }));
    const reopened = screen.getByRole("dialog", { name: "명령 이력" });
    await within(reopened).findByRole("button", { name: /A-first/ });
    expect(within(reopened).queryByRole("button", { name: /A-second/ })).not.toBeInTheDocument();
    expect(within(within(reopened).getByRole("navigation", { name: "페이지 이동" })).getByRole("status")).toHaveTextContent("1페이지");
  });

  it("resets cursor navigation for 1000 rows and transmits the size in its query", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => ({
      generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: false, items: [command("row")], nextCursor: url.includes("cursor=") ? null : "next"
    }) }));
    vi.stubGlobal("fetch", fetch); renderHistory();
    fireEvent.click(screen.getByRole("button", { name: "명령 이력 열기" }));
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "다음 페이지" })).toBeEnabled());
    fireEvent.click(within(drawer).getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(within(within(drawer).getByRole("navigation", { name: "페이지 이동" })).getByRole("status")).toHaveTextContent("2페이지"));
    openHistoryFilters();
    fireEvent.click(screen.getByRole("button", { name: "페이지당 항목 수" }));
    fireEvent.click(screen.getByRole("option", { name: "1000개" }));
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes("limit=1000") && !String(url).includes("cursor="))).toBe(true));
    expect(within(within(drawer).getByRole("navigation", { name: "페이지 이동" })).getByRole("status")).toHaveTextContent("1페이지");
  });

  it("explains an exact pre-RF clock refusal in the latest history without offering automatic execution", async () => {
    const refused = { ...command("clock-refused"), stage: "failed", outcome: "not_applied", errorCode: "GATEWAY_CLOCK_UNTRUSTED" };
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [refused], nextCursor: null }) });
    vi.stubGlobal("fetch", fetch);
    renderHistory();

    const recent = await screen.findByRole("region", { name: "최근 명령 이력" });
    const row = await within(recent).findByRole("button", { name: /clock-refused/ });
    expect(row).toHaveTextContent("게이트웨이 시각을 확인할 수 없어 조명에 전송하기 전 거부했습니다. 자동 재실행되지 않습니다.");
    expect(within(recent).queryByRole("button", { name: "다시 적용" })).not.toBeInTheDocument();
    expect(fetch.mock.calls.every(([url, init]) => String(url).includes("/api/commands?") && (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("keeps unknown and partial outcomes on the verification path and preserves expired-command presentation", async () => {
    const unknown = { ...command("unknown-command"), errorCode: "GATEWAY_CLOCK_UNTRUSTED" };
    const partial = { ...command("partial-command"), stage: "partial_failed", outcome: "partially_applied", errorCode: "GATEWAY_CLOCK_UNTRUSTED" };
    const expired = { ...command("expired-command"), stage: "failed", outcome: "not_applied", errorCode: "COMMAND_EXPIRED" };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => ({
      generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: url.includes("limit=1") ? [unknown] : [unknown, partial, expired], nextCursor: null
    }) })));
    const onOpenVerificationCases = vi.fn();
    renderHistory(vi.fn(), false, onOpenVerificationCases);

    const recent = await screen.findByRole("region", { name: "최근 명령 이력" });
    expect(await within(recent).findByRole("button", { name: /unknown-command/ })).toHaveTextContent("실제 상태 확인 필요");
    fireEvent.click(within(recent).getByRole("button", { name: "확인 필요한 명령" }));
    expect(onOpenVerificationCases).toHaveBeenCalledOnce();
    fireEvent.click(within(recent).getByRole("button", { name: "명령 이력 열기" }));
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    expect(await within(drawer).findByRole("button", { name: /partial-command/ })).toHaveTextContent("일부 조명 적용 실패");
    expect(within(drawer).getByRole("button", { name: /expired-command/ })).toHaveTextContent("명령 처리 실패");
    expect(within(drawer).queryByText(/게이트웨이 시각을 확인할 수 없어/)).not.toBeInTheDocument();
  });

  it("shows the clock refusal in compact history while keeping the command detail entry", async () => {
    const refused = { ...command("clock-refused"), stage: "failed", outcome: "not_applied", errorCode: "GATEWAY_CLOCK_UNTRUSTED" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [refused], nextCursor: null }) }));
    const { onSelect } = renderHistory(vi.fn(), true);

    const recent = await screen.findByRole("region", { name: "최근 명령 이력" });
    const detail = await within(recent).findByRole("button", { name: /최근 명령 상세: clock-refused/ });
    expect(detail).toHaveTextContent("시각 확인 실패");
    fireEvent.click(detail);
    expect(onSelect).toHaveBeenCalledWith("clock-refused");
  });

  it("keeps the compact latest-history bar concise while retaining detail, drawer and verification entry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      generatedAt: "2026-09-25T01:00:00.000Z", retainedFrom: "2026-06-25T01:00:00.000Z", retentionEnabled: false, items: [command("newest-command")], nextCursor: null
    }) }));
    const onOpenVerificationCases = vi.fn();
    const { onSelect } = renderHistory(vi.fn(), true, onOpenVerificationCases);
    const recent = await screen.findByRole("region", { name: "최근 명령 이력" });
    expect(await within(recent).findByRole("button", { name: /최근 명령 상세/ })).toHaveTextContent("2개");
    expect(within(recent).getByRole("button", { name: /최근 명령 상세/ })).toHaveTextContent("70%");
    expect(within(recent).getByRole("button", { name: /최근 명령 상세/ })).toHaveTextContent("실제 상태 확인 필요");
    expect(within(recent).queryByText(/최근 3개월/)).not.toBeInTheDocument();
    fireEvent.click(within(recent).getByRole("button", { name: /최근 명령 상세/ }));
    expect(onSelect).toHaveBeenCalledWith("newest-command");
    fireEvent.click(within(recent).getByRole("button", { name: "확인 필요한 명령" }));
    expect(onOpenVerificationCases).toHaveBeenCalledOnce();
    fireEvent.click(within(recent).getByRole("button", { name: "명령 이력 열기" }));
    expect(screen.getByRole("dialog", { name: "명령 이력" })).toHaveTextContent("최근 3개월");
  });

  it("atlas history shows the latest command separately and uses the server retention boundary", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      const limit = new URL(url, "http://localhost").searchParams.get("limit");
      return { ok: true, json: async () => ({
        retentionEnabled: false, items: limit === "1" ? [command("newest-command")] : [command("newest-command"), command("older-command")],
        nextCursor: null,
        generatedAt: "2026-09-25T01:00:00.000Z",
        retainedFrom: "2026-06-25T01:00:00.000Z"
      }) };
    });
    vi.stubGlobal("fetch", fetch);
    renderHistory();

    const recent = await screen.findByRole("region", { name: "최근 명령 이력" });
    expect(await within(recent).findByText("newest-command")).toBeInTheDocument();
    expect(within(recent).getByText(/최근 3개월/)).toBeInTheDocument();
    fireEvent.click(within(recent).getByRole("button", { name: "명령 이력 열기" }));
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    expect(await within(drawer).findByText("older-command")).toBeInTheDocument();
    expect(within(drawer).getByText(/2026.*6.*25/)).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("limit=1"))).toBe(true);
    expect(fetch.mock.calls.some(([url]) => String(url).includes("limit=50"))).toBe(true);
    expect(fetch.mock.calls.every(([url]) => String(url).includes("/api/commands?"))).toBe(true);
  });

  it("uses the shared search field and SelectBox trigger", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [], nextCursor: null }) }));
    renderHistory();

    await screen.findByText("명령 이력이 없습니다.");
    fireEvent.click(screen.getByRole("button", { name: "명령 이력 열기" }));
    expect(screen.getByRole("searchbox", { name: "명령 이력 검색" }).closest("[data-field]")).not.toBeNull();
    openHistoryFilters();
    expect(screen.getByRole("button", { name: "명령 상태 필터" })).toBeInTheDocument();
  });

  it("debounces search, changes stage filters and resets pagination for a new search", async () => {
    const fetch = vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [], nextCursor: null }) }));
    vi.stubGlobal("fetch", fetch);
    renderHistory();
    await screen.findByText("명령 이력이 없습니다.");
    fireEvent.click(screen.getByRole("button", { name: "명령 이력 열기" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole("searchbox", { name: "명령 이력 검색" }), { target: { value: "입" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "명령 이력 검색" }), { target: { value: "입구" } });
    expect(fetch).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls[2][0]).toContain("query=%EC%9E%85%EA%B5%AC");
    openHistoryFilters();
    fireEvent.click(screen.getByRole("button", { name: "명령 상태 필터" }));
    fireEvent.click(screen.getByRole("option", { name: "실제 상태 확인 필요" }));
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(fetch.mock.calls[3][0]).toContain("stage=verification_required");
    expect(fetch.mock.calls[3][0]).not.toContain("cursor=");
  });
  it("moves through opaque cursor pages and opens the chosen command without issuing a control", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => url.includes("cursor=")
      ? { generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [command("older-command")], nextCursor: null }
      : { generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [command("latest-command")], nextCursor: "opaque-cursor" } }));
    vi.stubGlobal("fetch", fetch);
    const { onSelect } = renderHistory();
    fireEvent.click(await screen.findByRole("button", { name: /latest-command/ }));
    expect(onSelect).toHaveBeenLastCalledWith("latest-command");
    fireEvent.click(screen.getByRole("button", { name: "명령 이력 열기" }));
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    const next = within(drawer).getByRole("button", { name: "다음 페이지" });
    await waitFor(() => expect(next).toBeEnabled());
    next.focus();
    fireEvent.click(next);
    await waitFor(() => expect(within(drawer).getByRole("button", { name: /older-command/ })).toBeInTheDocument());
    expect(within(drawer).getByRole("group", { name: "명령 이력 페이지 조작" })).toContainElement(document.activeElement as HTMLElement);
    fireEvent.click(await within(drawer).findByRole("button", { name: /older-command/ }));
    expect(onSelect).toHaveBeenLastCalledWith("older-command");
    expect(screen.getByRole("button", { name: /latest-command/ })).toBeInTheDocument();
    expect(fetch.mock.calls[2][0]).toContain("cursor=opaque-cursor");
    expect(fetch.mock.calls.every(([url]) => String(url).includes("/api/commands?"))).toBe(true);
  });
  it("returns to the first page when the server expires a history cursor", async () => {
    let firstPageReads = 0;
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      if (params.get("limit") === "1") return { ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [command("latest")], nextCursor: null }) };
      if (params.has("cursor")) return { ok: false, status: 400, headers: { get: () => "application/json" }, json: async () => ({ code: "command_history_cursor_expired" }) };
      firstPageReads += 1;
      return { ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [command("latest")], nextCursor: firstPageReads === 1 ? "expired-cursor" : null }) };
    });
    vi.stubGlobal("fetch", fetch);
    renderHistory();
    fireEvent.click(screen.getByRole("button", { name: "명령 이력 열기" }));
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    const next = within(drawer).getByRole("button", { name: "다음 페이지" });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    await waitFor(() => expect(firstPageReads).toBe(2));
    expect(next).toBeDisabled();
    expect(within(drawer).getByRole("button", { name: /latest/ })).toBeInTheDocument();
    expect(fetch.mock.calls.every(([url]) => String(url).includes("/api/commands?"))).toBe(true);
  });
  it("ignores a delayed cursor result after changing the stage filter", async () => {
    let finishOldPage: (value: unknown) => void = () => undefined;
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      if (params.has("cursor")) return new Promise((resolve) => { finishOldPage = resolve; });
      return { ok: true, json: async () => ({
        generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [command(params.has("stage") ? "filtered-command" : "first-command")],
        nextCursor: params.has("stage") ? null : "old-cursor"
      }) };
    });
    vi.stubGlobal("fetch", fetch);
    renderHistory();
    fireEvent.click(screen.getByRole("button", { name: "명령 이력 열기" }));
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    const next = within(drawer).getByRole("button", { name: "다음 페이지" });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    openHistoryFilters();
    fireEvent.click(screen.getByRole("button", { name: "명령 상태 필터" }));
    fireEvent.click(screen.getByRole("option", { name: "실제 상태 확인 필요" }));
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    expect(await within(drawer).findByRole("button", { name: /filtered-command/ })).toBeInTheDocument();
    finishOldPage({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [command("stale-command")], nextCursor: null }) });
    await waitFor(() => expect(next).toBeDisabled());
    expect(within(drawer).getByRole("button", { name: /filtered-command/ })).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /stale-command/ })).not.toBeInTheDocument();
  });
  it("offers a read retry on history failure", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [], nextCursor: null }) });
    vi.stubGlobal("fetch", fetch);
    renderHistory();
    fireEvent.click(await screen.findByRole("button", { name: "최근 명령 다시 조회" }));
    expect(await screen.findByText("명령 이력이 없습니다.")).toBeInTheDocument();
  });

  it("hides cached history rows after a background authorization loss", async () => {
    let drawerReads = 0;
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      const limit = new URL(url, "http://localhost").searchParams.get("limit");
      if (limit === "50") drawerReads += 1;
      return limit === "50" && drawerReads > 1
        ? { ok: false, status: 401, headers: { get: () => "application/json" }, json: async () => ({ code: "unauthorized" }) }
        : { ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [command("cached-command")], nextCursor: null }) };
    });
    vi.stubGlobal("fetch", fetch);
    const { client } = renderHistory();
    fireEvent.click(screen.getByRole("button", { name: "명령 이력 열기" }));
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    expect(await within(drawer).findByRole("button", { name: /cached-command/ })).toBeInTheDocument();
    await client.invalidateQueries({ queryKey: ["command-history", "user"] });
    await waitFor(() => expect(drawerReads).toBeGreaterThan(1));
    expect(within(drawer).queryByRole("button", { name: /cached-command/ })).not.toBeInTheDocument();
    expect(within(drawer).getByRole("alert")).toBeInTheDocument();
  });
});

function openHistoryFilters() {
  if (!screen.queryByRole("button", { name: "필터 닫기" })) fireEvent.click(screen.getByRole("button", { name: /명령 이력 필터 상세 필터/ }));
}
