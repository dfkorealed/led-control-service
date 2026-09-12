import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { incidentFixture } from "./monitoring-test-fixtures";
import { readFileSync } from "node:fs";
const styles = readFileSync("src/styles.css", "utf8");

import { MonitoringIncidentPanel } from "./MonitoringIncidentPanel";
let client: QueryClient;
let requests: Array<{ path: string; method: string; body: any }>;
let respond: (path: string, method: string, body: any) => Response | Promise<Response>;
const users = { users: [
  { id: "user-1", name: "현장 담당", loginId: "member", accessLevel: "read", status: "active", lastLoginAt: null, createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z" },
  { id: "disabled", name: "비활성 담당", loginId: "disabled", accessLevel: "read", status: "disabled", lastLoginAt: null, createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z" }
], count: 2, limit: 100 };
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  requests = [];
  respond = (path) => Response.json(path.endsWith("/users") ? users : { incidents: [incidentFixture()], activeCount: 1, nextCursor: null });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    return respond(path, method, body);
  }));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });
function mount(canManage = false) {
  return render(<QueryClientProvider client={client}><MonitoringIncidentPanel siteId="site-1" canManage={canManage} onActiveCountChange={() => undefined} /></QueryClientProvider>);
}

describe("incident operator workflow", () => {
  it("read-only sees history and filters but never requests users or renders management actions", async () => {
    mount();
    expect(await screen.findByText("입구 조명")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "인시던트 상태" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "확인" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "판정 기준" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "해결 메모" })).not.toBeInTheDocument();
    expect(requests.some(({ path }) => path.endsWith("/users"))).toBe(false);
  });

  it("uses filter-specific cursor pages, shows resolution history, and resets pagination on filter change", async () => {
    respond = (path) => Response.json(path.includes("cursor=next%2Bpage")
      ? { incidents: [incidentFixture({ id: "past", target: { kind: "gateway", id: "gw-1", name: "이전 게이트웨이" }, status: "resolved", resolutionKind: "automatic_recovery", resolvedAt: "2026-09-12T00:50:00.000Z", resolutionNote: "자동 복구 기록" })], activeCount: 1, nextCursor: null }
      : { incidents: [incidentFixture()], activeCount: 1, nextCursor: "next+page" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "더 보기" }));
    expect(await screen.findByText("이전 게이트웨이")).toBeVisible();
    expect(screen.getByText("자동 복구 기록")).toBeVisible();
    expect(screen.getByText("자동 복구")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "인시던트 상태" }), { target: { value: "resolved" } });
    fireEvent.change(screen.getByRole("combobox", { name: "인시던트 유형" }), { target: { value: "gateway_offline" } });
    await waitFor(() => expect(requests.at(-1)?.path).toBe("/api/sites/site-1/monitoring-incidents?status=resolved&type=gateway_offline&limit=20"));
    expect(screen.queryByText("이전 게이트웨이")).not.toBeInTheDocument();
  });

  it("sends row revision for acknowledge, active assignee and trimmed resolution and blocks duplicate requests", async () => {
    let resolvePatch!: (response: Response) => void;
    let row = incidentFixture();
    respond = (path, method, body) => {
      if (path.endsWith("/users")) return Response.json(users);
      if (method === "PATCH") {
        row = { ...row, status: body.action === "acknowledge" ? "acknowledged" : body.action === "resolve" ? "resolved" : row.status, updatedAt: "2026-09-12T02:00:00.000Z", assignedTo: body.action === "assign" && body.userId ? { id: "user-1", name: "현장 담당", loginId: "member" } : row.assignedTo };
        return new Promise((resolve) => { resolvePatch = resolve; });
      }
      return Response.json({ incidents: [row], activeCount: row.status === "resolved" ? 0 : 1, nextCursor: null });
    };
    mount(true);
    const acknowledge = await screen.findByRole("button", { name: "확인" });
    fireEvent.click(acknowledge);
    await waitFor(() => expect(acknowledge).toBeDisabled());
    fireEvent.click(acknowledge);
    expect(requests.filter(({ method }) => method === "PATCH")).toHaveLength(1);
    expect(requests.at(-1)?.body).toEqual({ action: "acknowledge", expectedUpdatedAt: "2026-09-12T01:00:00.000Z" });
    await act(async () => resolvePatch(Response.json(row)));
    await waitFor(() => expect(screen.queryByRole("button", { name: "확인" })).not.toBeInTheDocument());
    const assignee = screen.getByRole("combobox", { name: "담당자" });
    expect(within(assignee).queryByRole("option", { name: /비활성/ })).not.toBeInTheDocument();
    fireEvent.change(assignee, { target: { value: "user-1" } });
    fireEvent.click(screen.getByRole("button", { name: "담당 저장" }));
    await waitFor(() => expect(requests.at(-1)?.body).toEqual({ action: "assign", userId: "user-1", expectedUpdatedAt: "2026-09-12T02:00:00.000Z" }));
    await act(async () => resolvePatch(Response.json(row)));
    await waitFor(() => expect(screen.getByRole("button", { name: "담당 저장" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "해결 메모" }), { target: { value: "  정상 수신 확인  " } });
    fireEvent.click(screen.getByRole("button", { name: "해결" }));
    await waitFor(() => expect(requests.at(-1)?.body).toEqual({ action: "resolve", note: "정상 수신 확인", expectedUpdatedAt: "2026-09-12T02:00:00.000Z" }));
    await act(async () => resolvePatch(Response.json(row)));
    await waitFor(() => expect(screen.queryByRole("button", { name: "해결" })).not.toBeInTheDocument());
  });

  it.each([
    ["INCIDENT_CONFLICT", "다른 사용자가"],
    ["INCIDENT_INVALID_STATE", "상태가 변경"],
    ["INCIDENT_STILL_ACTIVE", "장애가 지속"],
    ["INCIDENT_TARGET_CHANGED", "대상 연결이 변경"]
  ])("announces %s distinctly and refetches without repeating the write", async (code, message) => {
    respond = (path, method) => method === "PATCH" ? Response.json({ code }, { status: 409 }) : Response.json(path.endsWith("/users") ? users : { incidents: [incidentFixture()], activeCount: 1, nextCursor: null });
    mount(true);
    fireEvent.click(await screen.findByRole("button", { name: "확인" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    await waitFor(() => expect(requests.filter(({ path, method }) => path.includes("monitoring-incidents?") && method === "GET").length).toBeGreaterThan(1));
    expect(requests.filter(({ method }) => method === "PATCH")).toHaveLength(1);
    expect(screen.getByText("입구 조명")).toBeVisible();
  });

  it("keeps cached rows on background failure and exposes retry", async () => {
    mount();
    expect(await screen.findByText("입구 조명")).toBeVisible();
    respond = () => Response.json({}, { status: 503 });
    await act(async () => { await client.invalidateQueries({ queryKey: ["monitoring-incidents", "site-1"] }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("저장된 인시던트");
    expect(screen.getByText("입구 조명")).toBeVisible();
    expect(screen.getByRole("button", { name: "인시던트 다시 시도" })).toBeEnabled();
  });

  it("rejects blank resolution notes and sends explicit null when unassigning an active incident", async () => {
    const row = incidentFixture({ assignedTo: { id: "user-1", name: "현장 담당", loginId: "member" } });
    respond = (path, method) => Response.json(method === "PATCH" ? row : path.endsWith("/users") ? users : { incidents: [row], activeCount: 1, nextCursor: null });
    mount(true);
    fireEvent.click(await screen.findByRole("button", { name: "해결" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1~2000자");
    expect(requests.filter(({ method }) => method === "PATCH")).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "담당자" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "담당자" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "담당 저장" }));
    await waitFor(() => expect(requests.find(({ method }) => method === "PATCH")?.body).toEqual({ action: "assign", userId: null, expectedUpdatedAt: "2026-09-12T01:00:00.000Z" }));
  });

  it("keeps the conflict announcement when refreshed state removes the row's action form", async () => {
    let conflicted = false;
    respond = (path, method) => {
      if (method === "PATCH") { conflicted = true; return Response.json({ code: "INCIDENT_INVALID_STATE" }, { status: 409 }); }
      return Response.json(path.endsWith("/users") ? users : { incidents: [incidentFixture({ status: conflicted ? "resolved" : "open", resolvedAt: conflicted ? "2026-09-12T02:00:00.000Z" : null })], activeCount: conflicted ? 0 : 1, nextCursor: null });
    };
    mount(true);
    fireEvent.click(await screen.findByRole("button", { name: "확인" }));
    expect(await screen.findByText("해결됨")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("button", { name: "확인" })).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("상태가 변경");
  });

  it("keeps an in-flight write disabled after changing filters remounts its action form", async () => {
    let finish!: (response: Response) => void;
    respond = (path, method) => method === "PATCH" ? new Promise((resolve) => { finish = resolve; }) : Response.json(path.endsWith("/users") ? users : { incidents: [incidentFixture()], activeCount: 1, nextCursor: null });
    mount(true);
    fireEvent.click(await screen.findByRole("button", { name: "확인" }));
    await waitFor(() => expect(requests.filter(({ method }) => method === "PATCH")).toHaveLength(1));
    fireEvent.change(screen.getByRole("combobox", { name: "인시던트 상태" }), { target: { value: "open" } });
    await waitFor(() => expect(requests.at(-1)?.path).toContain("status=open"));
    const acknowledge = await screen.findByRole("button", { name: "확인" });
    expect(acknowledge).toBeDisabled();
    fireEvent.click(acknowledge);
    expect(requests.filter(({ method }) => method === "PATCH")).toHaveLength(1);
    await act(async () => finish(Response.json(incidentFixture())));
  });

  it("exposes a retryable initial failure and later reports active count from loaded history", async () => {
    respond = () => Response.json({}, { status: 503 });
    const onCount = vi.fn();
    render(<QueryClientProvider client={client}><MonitoringIncidentPanel siteId="site-1" canManage={false} onActiveCountChange={onCount} /></QueryClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("불러오지 못했습니다");
    expect(onCount).not.toHaveBeenCalled();
    respond = () => Response.json({ incidents: [incidentFixture()], activeCount: 8, nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "인시던트 다시 시도" }));
    expect(await screen.findByText("입구 조명")).toBeVisible();
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(8));
  });

  it("applies shrinkable wrapping layout to the real filter and action controls", async () => {
    const style = document.createElement("style"); style.textContent = styles; document.head.append(style);
    const view = mount(true);
    await screen.findByText("입구 조명");
    const filters = screen.getByRole("group", { name: "인시던트 필터" });
    expect(getComputedStyle(filters).gridTemplateColumns).toContain("minmax(0, 1fr)");
    expect(getComputedStyle(screen.getByRole("combobox", { name: "인시던트 유형" })).minWidth).toBe("0");
    expect(getComputedStyle(view.container.querySelector(".monitoring-incident-card")!).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(screen.getByRole("group", { name: "인시던트 조치" })).minWidth).toBe("0");
    style.remove();
  });
});
