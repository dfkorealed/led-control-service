import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandHistoryPanel } from "./CommandHistoryPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHistory(onSelect = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CommandHistoryPanel userId="user" siteId="site" onSelect={onSelect} /></QueryClientProvider>);
  return { onSelect };
}

function command(id: string) {
  return { id, stage: "verification_required", outcome: "unknown", brightness: 70, totalFixtureCount: 2, completedFixtureCount: 2, createdAt: "2026-09-12T01:00:00.000Z", dispatchCount: 1, errorMessage: null, verificationAttemptCount: 0 };
}

describe("CommandHistoryPanel", () => {
  it("debounces search, changes stage filters and resets pagination for a new search", async () => {
    const fetch = vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ items: [], nextCursor: null }) }));
    vi.stubGlobal("fetch", fetch);
    renderHistory();
    await screen.findByText("명령 이력이 없습니다.");
    fireEvent.change(screen.getByRole("searchbox", { name: "명령 이력 검색" }), { target: { value: "입" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "명령 이력 검색" }), { target: { value: "입구" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1][0]).toContain("query=%EC%9E%85%EA%B5%AC");
    fireEvent.change(screen.getByRole("combobox", { name: "명령 상태 필터" }), { target: { value: "verification_required" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls[2][0]).toContain("stage=verification_required");
    expect(fetch.mock.calls[2][0]).not.toContain("cursor=");
  });
  it("appends the next cursor page and opens the chosen command without issuing a control", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => url.includes("cursor=")
      ? { items: [command("older-command")], nextCursor: null }
      : { items: [command("latest-command")], nextCursor: "opaque-cursor" } }));
    vi.stubGlobal("fetch", fetch);
    const { onSelect } = renderHistory();
    fireEvent.click(await screen.findByRole("button", { name: /latest-command/ }));
    expect(onSelect).toHaveBeenLastCalledWith("latest-command");
    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    fireEvent.click(await screen.findByRole("button", { name: /older-command/ }));
    expect(onSelect).toHaveBeenLastCalledWith("older-command");
    expect(screen.getByRole("button", { name: /latest-command/ })).toBeInTheDocument();
    expect(fetch.mock.calls[1][0]).toContain("cursor=opaque-cursor");
    expect(screen.queryByRole("button", { name: "더 보기" })).not.toBeInTheDocument();
  });
  it("offers a read retry on history failure", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue({ ok: true, json: async () => ({ items: [], nextCursor: null }) });
    vi.stubGlobal("fetch", fetch);
    renderHistory();
    fireEvent.click(await screen.findByRole("button", { name: "이력 다시 조회" }));
    expect(await screen.findByText("명령 이력이 없습니다.")).toBeInTheDocument();
  });
});
