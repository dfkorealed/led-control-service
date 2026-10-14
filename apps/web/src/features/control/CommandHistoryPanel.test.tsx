import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandHistoryPanel } from "./CommandHistoryPanel";

afterEach(() => { cleanup(); onlineManager.setOnline(true); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderHistory(onSelect = vi.fn(), compactDisclosure = false, onOpenVerificationCases?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CommandHistoryPanel userId="user" siteId="site" onSelect={onSelect} compactDisclosure={compactDisclosure} onOpenVerificationCases={onOpenVerificationCases} /></QueryClientProvider>);
  return { onSelect, client };
}

function command(id: string) {
  return { id, stage: "verification_required", outcome: "unknown", brightness: 70, totalFixtureCount: 2, completedFixtureCount: 2, createdAt: "2026-09-12T01:00:00.000Z", dispatchCount: 1, errorMessage: null, verificationAttemptCount: 0 };
}

describe("CommandHistoryPanel", () => {
  it("fidelity labels the control history ticker while keeping UUID detail selection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: false,
      items: [command("actual-uuid")], nextCursor: null
    }) }));
    const { onSelect, client } = renderHistory();
    const ticker = screen.getByRole("region", { name: "제어 이력" });
    const detail = await within(ticker).findByRole("button", { name: /최근 명령 상세: actual-uuid/ });
    fireEvent.click(detail);
    expect(onSelect).toHaveBeenCalledWith("actual-uuid");
    client.clear();
  });
  it("keeps failed recent-history text in its own flow while retry, full history and verification remain separate read-only actions", async () => {
    let failRecent = true;
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      const recent = new URL(url, "http://localhost").searchParams.get("limit") === "5";
      return recent && failRecent
        ? { ok: false, status: 503, headers: { get: () => "application/json" }, json: async () => ({ message: "history unavailable" }) }
        : { ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: false, items: [], nextCursor: null }) };
    });
    vi.stubGlobal("fetch", fetch);
    const onVerify = vi.fn();
    const { onSelect, client } = renderHistory(vi.fn(), true, onVerify);
    const recent = screen.getByRole("region", { name: "최근 명령 이력" });
    const error = await within(recent).findByRole("alert");
    expect(error).toHaveTextContent("최근 명령을 불러오지 못했습니다.");
    expect(error.parentElement).toHaveClass("w-full");
    expect(error.parentElement).not.toHaveClass("overflow-hidden");
    const opener = within(recent).getByRole("button", { name: "전체 보기" });
    expect(opener).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(within(recent).getByRole("button", { name: "확인 필요한 명령" }));
    expect(onVerify).toHaveBeenCalledOnce();
    failRecent = false;
    fireEvent.click(within(recent).getByRole("button", { name: "다시 조회" }));
    await within(recent).findByText("명령 이력이 없습니다.");
    expect(within(recent).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(recent).queryByRole("button", { name: "다시 조회" })).not.toBeInTheDocument();
    expect(within(recent).getByRole("button", { name: "전체 보기" })).toBe(opener);
    opener.focus(); fireEvent.click(opener);
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    await within(drawer).findByText("명령 이력이 없습니다.");
    fireEvent.click(within(drawer).getByRole("button", { name: "명령 이력 닫기" }));
    await waitFor(() => expect(opener).toHaveFocus());
    expect(onSelect).not.toHaveBeenCalled();
    expect(fetch.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    client.clear();
  });
  it("keeps the five-second clock and current row through one-second parent renders with fresh hook arrays and callbacks", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: false,
      items: [command("first-uuid"), command("second-uuid")], nextCursor: null
    }) });
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const callbacks = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const tree = (tick: number, disabled = false, selectedCommandId: string | null = null) =>
      <QueryClientProvider client={client}><CommandHistoryPanel userId="user" siteId="site"
        onSelect={id => callbacks[tick](id)} disabled={disabled} selectedCommandId={selectedCommandId} /></QueryClientProvider>;
    const view = render(tree(0));
    await screen.findByRole("button", { name: /최근 명령 상세: first-uuid/ });
    for (let tick = 1; tick <= 4; tick += 1) {
      act(() => vi.advanceTimersByTime(1000));
      view.rerender(tree(tick));
      expect(screen.getByRole("button", { name: /최근 명령 상세: first-uuid/ })).toBeInTheDocument();
    }
    act(() => vi.advanceTimersByTime(999));
    expect(screen.queryByRole("button", { name: /최근 명령 상세: second-uuid/ })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("button", { name: /최근 명령 상세: second-uuid/ })).toBeInTheDocument();
    // Interaction state must stay live without becoming ticker reset identity.
    view.rerender(tree(5, true, "second-uuid"));
    const locked = screen.getByRole("button", { name: /최근 명령 상세: second-uuid/ });
    expect(locked).toBeDisabled(); expect(locked).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(locked); expect(callbacks.every(callback => callback.mock.calls.length === 0)).toBe(true);
    view.rerender(tree(5, false, "first-uuid"));
    const current = screen.getByRole("button", { name: /최근 명령 상세: second-uuid/ });
    expect(current).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(current); expect(callbacks[5]).toHaveBeenCalledWith("second-uuid");
    expect(callbacks.slice(0, 5).every(callback => callback.mock.calls.length === 0)).toBe(true);
    expect(fetch.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    view.unmount(); client.clear(); expect(vi.getTimerCount()).toBe(0);
  });

  it("resets rotation for actual recent content and user/site scope changes, not equivalent reconstructed rows", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const response = { generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: false,
      items: [command("first-uuid"), command("second-uuid")], nextCursor: null };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => response }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (userId = "user", siteId = "site", timeZone = "UTC") => <QueryClientProvider client={client}>
      <CommandHistoryPanel userId={userId} siteId={siteId} timeZone={timeZone} onSelect={() => undefined} /></QueryClientProvider>;
    const view = render(tree());
    await screen.findByRole("button", { name: /최근 명령 상세: first-uuid/ });
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole("button", { name: /최근 명령 상세: second-uuid/ })).toBeInTheDocument();
    view.rerender(tree());
    expect(screen.getByRole("button", { name: /최근 명령 상세: second-uuid/ })).toBeInTheDocument();
    act(() => client.setQueryData(["command-history", "user", { siteId: "site", limit: 5 }], (data: { pages: typeof response[]; pageParams: unknown[] } | undefined) => data && ({
      ...data, pages: data.pages.map(page => ({ ...page, items: page.items.map(item => ({ ...item, brightness: 30 })) }))
    })));
    expect(await screen.findByRole("button", { name: /최근 명령 상세: first-uuid/ })).toHaveTextContent("30%");
    act(() => vi.advanceTimersByTime(4999));
    expect(screen.queryByRole("button", { name: /최근 명령 상세: second-uuid/ })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("button", { name: /최근 명령 상세: second-uuid/ })).toBeInTheDocument();
    view.rerender(tree("other-user", "other-site"));
    await screen.findByRole("button", { name: /최근 명령 상세: first-uuid/ });
    act(() => vi.advanceTimersByTime(4999));
    expect(screen.queryByRole("button", { name: /최근 명령 상세: second-uuid/ })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("button", { name: /최근 명령 상세: second-uuid/ })).toBeInTheDocument();
    view.rerender(tree("other-user", "other-site", "Asia/Seoul"));
    expect(screen.getByRole("button", { name: /최근 명령 상세: first-uuid/ })).toHaveAccessibleName(/2026-09-12 10:00:00/);
    view.unmount(); client.clear();
  });

  it("preserves adapter hover and focus pauses while unrelated parents reconstruct the same recent commands", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: false,
      items: [command("first-uuid"), command("second-uuid")], nextCursor: null
    }) }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = () => <QueryClientProvider client={client}><CommandHistoryPanel userId="user" siteId="site" onSelect={() => undefined} /></QueryClientProvider>;
    const view = render(tree()); await screen.findByRole("button", { name: /최근 명령 상세: first-uuid/ });
    act(() => vi.advanceTimersByTime(5000));
    const ticker = screen.getByRole("region", { name: "제어 이력" });
    fireEvent.mouseEnter(ticker); view.rerender(tree());
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByRole("button", { name: /최근 명령 상세: second-uuid/ })).toBeInTheDocument();
    fireEvent.mouseLeave(ticker); fireEvent.focus(screen.getByRole("button", { name: "전체 보기" }));
    view.rerender(tree()); act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByRole("button", { name: /최근 명령 상세: second-uuid/ })).toBeInTheDocument();
    fireEvent.blur(ticker, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(4999));
    expect(screen.getByRole("button", { name: /최근 명령 상세: second-uuid/ })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("button", { name: /최근 명령 상세: first-uuid/ })).toBeInTheDocument();
    view.unmount(); client.clear(); expect(vi.getTimerCount()).toBe(0);
  });

  it("hides cached ticker commands while a requested read is paused offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: false,
      items: [command("cached-uuid")], nextCursor: null
    }) }));
    const { client } = renderHistory();
    await screen.findByRole("button", { name: /최근 명령 상세: cached-uuid/ });
    onlineManager.setOnline(false);
    void client.refetchQueries({ queryKey: ["command-history", "user", { siteId: "site", limit: 5 }], exact: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: /최근 명령 상세:/ })).not.toBeInTheDocument());
    expect(client.getQueryState(["command-history", "user", { siteId: "site", limit: 5 }])?.fetchStatus).toBe("paused");
    client.clear();
  });

  it.each([401, 403, 503])("does not retain a ticker command during a live refetch or after its %s failure", async status => {
    let resolveRead!: (response: unknown) => void;
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({
      generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: false,
      items: [command("cached-uuid"), command("second-uuid")], nextCursor: null
    }) }).mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
    vi.stubGlobal("fetch", fetch); const { client, onSelect } = renderHistory();
    await screen.findByRole("button", { name: /최근 명령 상세: cached-uuid/ });
    const refetch = client.refetchQueries({ queryKey: ["command-history", "user", { siteId: "site", limit: 5 }], exact: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: /최근 명령 상세:/ })).not.toBeInTheDocument());
    resolveRead({ ok: false, status, headers: { get: () => "application/json" }, json: async () => ({ message: "history unavailable" }) });
    await refetch;
    expect(await screen.findByText("최근 명령을 불러오지 못했습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /최근 명령 상세:/ })).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled(); client.clear();
  });

  it("drops retention-expired ticker content before the expiry revalidation finishes", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({
      generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: true,
      items: [{ ...command("expiring-uuid"), createdAt: "2026-06-25T00:00:02Z" }, command("retained-uuid")], nextCursor: null
    }) }).mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = () => <QueryClientProvider client={client}><CommandHistoryPanel userId="user" siteId="site" onSelect={() => undefined} /></QueryClientProvider>;
    const view = render(tree());
    await screen.findByRole("button", { name: /최근 명령 상세: expiring-uuid/ });
    elapsed = 2001; view.rerender(tree());
    expect(screen.queryByRole("button", { name: /최근 명령 상세: expiring-uuid/ })).not.toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /최근 명령 상세:/ })).not.toBeInTheDocument();
    view.unmount(); client.clear();
  });

  it("reads five real recent commands and rotates after exactly five seconds while retaining full history", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: false,
      items: [command("first-uuid"), { ...command("second-uuid"), brightness: 0, totalFixtureCount: 0, stage: "partial_failed", outcome: "partially_applied" }], nextCursor: null
    }) });
    vi.stubGlobal("fetch", fetch); const { onSelect } = renderHistory(vi.fn(), true);
    const first = await screen.findByRole("button", { name: /최근 명령 상세: first-uuid/ });
    expect(new URL(String(fetch.mock.calls[0][0]), "http://localhost").searchParams.get("limit")).toBe("5");
    act(() => { vi.advanceTimersByTime(4999); });
    expect(first).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    const second = screen.getByRole("button", { name: /최근 명령 상세: second-uuid/ });
    expect(second).toHaveTextContent("0개"); expect(second).toHaveTextContent("0%");
    expect(screen.getByRole("region", { name: "제어 이력" })).toHaveTextContent("일부 조명 적용 실패");
    fireEvent.click(second); expect(onSelect).toHaveBeenCalledWith("second-uuid");
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    await within(drawer).findByRole("button", { name: /first-uuid/ });
    expect(fetch.mock.calls.some(([url]) => new URL(String(url), "http://localhost").searchParams.get("limit") === "50")).toBe(true);
    expect(fetch.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });
  it.each([
    { kind: "partial", raw: [2026, null, null, null, null, null] },
    { kind: "impossible", raw: [2026, 2, 30, 2026, 3, 1] },
    { kind: "reversed", raw: [2026, 3, 2, 2026, 3, 1] }
  ])("blocks manual retry after a history error while the $kind draft survives filter reopen, then reads a valid correction", async ({ kind, raw }) => {
    const fullHistoryReads: URL[] = [];
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(url, "http://localhost");
      if (parsed.searchParams.get("limit") !== "5") fullHistoryReads.push(parsed);
      if (parsed.searchParams.get("limit") !== "5" && !parsed.searchParams.has("fromDate")) {
        return { ok: false, status: 503, json: async () => ({ message: "history unavailable" }) };
      }
      return { ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: false,
        items: parsed.searchParams.get("limit") === "5" ? [command("latest")] : [command("corrected-period")], nextCursor: null }) };
    });
    vi.stubGlobal("fetch", fetch); renderHistory();
    const recent = await screen.findByRole("region", { name: "최근 명령 이력" });
    await within(recent).findByRole("button", { name: /latest/ });
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
    await screen.findByText("명령 이력을 불러오지 못했습니다.");
    expect(fullHistoryReads).toHaveLength(1);
    openHistoryFilters();
    // Real segment keyboard edits keep the date component/controller real.
    // Set the day before month so an impossible raw date is not pre-constrained.
    for (const index of [3, 5, 4, 0, 2, 1]) {
      if (raw[index] !== null) editHistoryDateSegment(index, raw[index]!);
    }
    expect(screen.getAllByRole("spinbutton").map(element => element.getAttribute("aria-valuenow"))).toEqual(raw.map(value => value === null ? null : String(value)));
    expect(screen.getByRole("group", { name: "조회 기간" })).toHaveAccessibleDescription(/올바른 순서로 완성/);
    const readsBeforeRetry = fullHistoryReads.length;
    expect(readsBeforeRetry).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    // A reversed complete range changes the committed query key and has no
    // prior error on that key. Partial/impossible drafts retain the failed key.
    const retry = screen.queryByRole("button", { name: "이력 다시 조회" });
    if (kind === "reversed") expect(retry).not.toBeInTheDocument();
    else expect(retry).toBeInTheDocument();
    if (retry) fireEvent.click(retry);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(fullHistoryReads).toHaveLength(readsBeforeRetry);
    if (retry) expect(retry).toBeDisabled();
    openHistoryFilters();
    expect(screen.getAllByRole("spinbutton").map(element => element.getAttribute("aria-valuenow"))).toEqual(raw.map(value => value === null ? null : String(value)));
    for (const [index, value] of [2026, 3, 1, 2026, 3, 2].entries()) editHistoryDateSegment(index, value);
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    await screen.findByRole("button", { name: /corrected-period/ });
    expect(fullHistoryReads.at(-1)?.searchParams.get("fromDate")).toBe("2026-03-01");
    expect(fullHistoryReads.at(-1)?.searchParams.get("toDate")).toBe("2026-03-02");
    // The modal makes the background inert, not stale; retain its actual UUID.
    expect(recent.querySelector('[aria-label^="최근 명령 상세: latest"]')).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "명령 이력" })).toHaveTextContent("최근 3개월");
    expect(fetch.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("preserves partial date draft across filter close", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00Z", retainedFrom: "2026-06-25T00:00:00Z", retentionEnabled: false, items: [], nextCursor: null }) });
    vi.stubGlobal("fetch", fetch); renderHistory();
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
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
    const fetch = vi.fn().mockImplementation((url: string) => new URL(url, "http://localhost").searchParams.get("limit") === "5"
      ? Promise.resolve({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00Z", retentionEnabled: false, items: [], nextCursor: null }) })
      : new Promise(resolve => { release = resolve; }));
    vi.stubGlobal("fetch", fetch); renderHistory();
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
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
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
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
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
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
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
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
    expect(recent).toHaveTextContent("게이트웨이 시각을 확인할 수 없어 조명에 전송하기 전 거부했습니다. 자동 재실행되지 않습니다.");
    expect(row).toHaveAccessibleName(/자동 재실행되지 않습니다/);
    expect(within(recent).queryByRole("button", { name: "다시 적용" })).not.toBeInTheDocument();
    expect(fetch.mock.calls.every(([url, init]) => String(url).includes("/api/commands?") && (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("keeps unknown and partial outcomes on the verification path and preserves expired-command presentation", async () => {
    const unknown = { ...command("unknown-command"), errorCode: "GATEWAY_CLOCK_UNTRUSTED" };
    const partial = { ...command("partial-command"), stage: "partial_failed", outcome: "partially_applied", errorCode: "GATEWAY_CLOCK_UNTRUSTED" };
    const expired = { ...command("expired-command"), stage: "failed", outcome: "not_applied", errorCode: "COMMAND_EXPIRED" };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => ({
      generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: new URL(url, "http://localhost").searchParams.get("limit") === "5" ? [unknown] : [unknown, partial, expired], nextCursor: null
    }) })));
    const onOpenVerificationCases = vi.fn();
    renderHistory(vi.fn(), false, onOpenVerificationCases);

    const recent = await screen.findByRole("region", { name: "최근 명령 이력" });
    expect(await within(recent).findByRole("button", { name: /unknown-command/ })).toHaveAccessibleName(/실제 상태 확인 필요/);
    expect(recent).toHaveTextContent("실제 상태 확인 필요");
    fireEvent.click(within(recent).getByRole("button", { name: "확인 필요한 명령" }));
    expect(onOpenVerificationCases).toHaveBeenCalledOnce();
    fireEvent.click(within(recent).getByRole("button", { name: "전체 보기" }));
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
    const detail = await within(recent).findByRole("button", { name: /최근 명령 상세/ });
    // JSDOM checks the mobile hit-shape declaration, not painted geometry.
    // The unchanged compact-history Chromium cases prove continuous44 reach.
    expect(detail).toHaveClass("max-compact:rounded-none", "min-h-11!", "min-w-11", "rounded-control");
    expect(detail).not.toHaveClass("rounded-none");
    expect(detail).toHaveAttribute("type", "button");
    expect(detail).toHaveTextContent("2개");
    expect(detail).toHaveTextContent("70%");
    expect(detail).toHaveAccessibleName(/최근 명령 상세: newest-command .*실제 상태 확인 필요/);
    expect(recent).toHaveTextContent("실제 상태 확인 필요");
    expect(within(recent).queryByText(/최근 3개월/)).not.toBeInTheDocument();
    fireEvent.click(detail);
    expect(onSelect).toHaveBeenCalledWith("newest-command");
    fireEvent.click(within(recent).getByRole("button", { name: "확인 필요한 명령" }));
    expect(onOpenVerificationCases).toHaveBeenCalledOnce();
    fireEvent.click(within(recent).getByRole("button", { name: "전체 보기" }));
    expect(screen.getByRole("dialog", { name: "명령 이력" })).toHaveTextContent("최근 3개월");
  });

  it("atlas history shows the latest command separately and uses the server retention boundary", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      const limit = new URL(url, "http://localhost").searchParams.get("limit");
      return { ok: true, json: async () => ({
        retentionEnabled: false, items: limit === "5" ? [command("newest-command")] : [command("newest-command"), command("older-command")],
        nextCursor: null,
        generatedAt: "2026-09-25T01:00:00.000Z",
        retainedFrom: "2026-06-25T01:00:00.000Z"
      }) };
    });
    vi.stubGlobal("fetch", fetch);
    renderHistory();

    const recent = await screen.findByRole("region", { name: "최근 명령 이력" });
    expect(await within(recent).findByRole("button", { name: /최근 명령 상세: newest-command/ })).toBeInTheDocument();
    fireEvent.click(within(recent).getByRole("button", { name: "전체 보기" }));
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    expect(await within(drawer).findByText("older-command")).toBeInTheDocument();
    expect(within(drawer).getByText(/2026.*6.*25/)).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("limit=5"))).toBe(true);
    expect(fetch.mock.calls.some(([url]) => String(url).includes("limit=50"))).toBe(true);
    expect(fetch.mock.calls.every(([url]) => String(url).includes("/api/commands?"))).toBe(true);
  });

  it("uses the shared search field and SelectBox trigger", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [], nextCursor: null }) }));
    renderHistory();

    await screen.findByText("명령 이력이 없습니다.");
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
    expect(screen.getByRole("searchbox", { name: "명령 이력 검색" }).closest("[data-field]")).not.toBeNull();
    openHistoryFilters();
    expect(screen.getByRole("button", { name: "명령 상태 필터" })).toBeInTheDocument();
  });

  it("debounces search, changes stage filters and resets pagination for a new search", async () => {
    const fetch = vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [], nextCursor: null }) }));
    vi.stubGlobal("fetch", fetch);
    renderHistory();
    await screen.findByText("명령 이력이 없습니다.");
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
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
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
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
      if (params.get("limit") === "5") return { ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [command("latest")], nextCursor: null }) };
      if (params.has("cursor")) return { ok: false, status: 400, headers: { get: () => "application/json" }, json: async () => ({ code: "command_history_cursor_expired" }) };
      firstPageReads += 1;
      return { ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [command("latest")], nextCursor: firstPageReads === 1 ? "expired-cursor" : null }) };
    });
    vi.stubGlobal("fetch", fetch);
    renderHistory();
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
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
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "다시 조회" }));
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
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    expect(await within(drawer).findByRole("button", { name: /cached-command/ })).toBeInTheDocument();
    await client.invalidateQueries({ queryKey: ["command-history", "user"] });
    await waitFor(() => expect(drawerReads).toBeGreaterThan(1));
    expect(within(drawer).queryByRole("button", { name: /cached-command/ })).not.toBeInTheDocument();
    expect(within(drawer).getByRole("alert")).toBeInTheDocument();
  });
});

function editHistoryDateSegment(index: number, value: number) {
  const segment = screen.getAllByRole("spinbutton")[index];
  act(() => segment.focus());
  for (let clear = 0; clear < 4; clear += 1) fireEvent.keyDown(segment, { key: "Backspace", code: "Backspace" });
  for (const key of String(value)) fireEvent(segment, new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: key, inputType: "insertText" }));
}

function openHistoryFilters() {
  if (!screen.queryByRole("button", { name: "필터 닫기" })) fireEvent.click(screen.getByRole("button", { name: /명령 이력 필터 상세 필터/ }));
}

it("uses one ticker and one drawer for separate permanent and temporary history kinds", async () => {
  const temporary = { id: "22222222-2222-4222-8222-222222222222", siteId: "11111111-1111-4111-8111-111111111111", gatewayId: "44444444-4444-4444-8444-444444444444",
    state: "pending", sessionRevision: 1, now: "2026-10-15T00:00:00.000Z", startedAt: "2026-10-15T00:00:00.000Z", endsAt: "2026-10-15T00:15:00.000Z", brightness: 70,
    targets: [{ fixtureId: "33333333-3333-4333-8333-333333333333", meshNodeId: "55555555-5555-4555-8555-555555555555", nativeUuid: "abcdef123456", logicalAddress: "0x1001", applyGeneration: "1", releaseGeneration: "2" }], results: [], reason: null, detailsRedacted: false };
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => url.includes("temporary-controls")
    ? url.includes(temporary.id) ? temporary : { items: [temporary], nextCursor: null }
    : { generatedAt: "2026-10-15T00:00:00Z", retainedFrom: "2026-07-15T00:00:00Z", retentionEnabled: false, items: [], nextCursor: null } })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CommandHistoryPanel userId="actor" siteId={temporary.siteId} onSelect={vi.fn()} temporaryEnabled /></QueryClientProvider>);
  expect(await screen.findByRole("button", { name: /최근 시간제 상세/ })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "전체 보기" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
  expect(screen.getAllByRole("dialog", { name: "명령 이력" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "시간제 이력" }));
  expect(await screen.findByRole("button", { name: new RegExp(temporary.id) })).toBeInTheDocument();
  client.clear();
});
