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
    expect(fetch.mock.calls.some(([url]) => String(url).includes("limit=4"))).toBe(true);
    expect(fetch.mock.calls.every(([url]) => String(url).includes("/api/commands?"))).toBe(true);
  });

  it("uses the shared search field and SelectBox trigger", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, items: [], nextCursor: null }) }));
    renderHistory();

    await screen.findByText("명령 이력이 없습니다.");
    fireEvent.click(screen.getByRole("button", { name: "명령 이력 열기" }));
    expect(screen.getByRole("searchbox", { name: "명령 이력 검색" }).closest("[data-field]")).not.toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "명령 상태 필터" }));
    fireEvent.click(screen.getByRole("option", { name: "실제 상태 확인 필요" }));
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
    const next = within(drawer).getByRole("button", { name: "다음" });
    await waitFor(() => expect(next).toBeEnabled());
    next.focus();
    fireEvent.click(next);
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "이전" })).toHaveFocus());
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
    const next = within(drawer).getByRole("button", { name: "다음" });
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
    const next = within(drawer).getByRole("button", { name: "다음" });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    fireEvent.click(within(drawer).getByRole("button", { name: "명령 상태 필터" }));
    fireEvent.click(screen.getByRole("option", { name: "실제 상태 확인 필요" }));
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
      if (limit === "4") drawerReads += 1;
      return limit === "4" && drawerReads > 1
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
