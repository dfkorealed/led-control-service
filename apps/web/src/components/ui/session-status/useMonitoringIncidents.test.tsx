import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { type PropsWithChildren, StrictMode, useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStatusCenter } from "./SessionStatusCenter";
import { SessionStatusProvider, useSessionStatus, useSessionToast } from "./SessionStatusProvider";
import { useMonitoringIncidents } from "./useMonitoringIncidents";
import { listPendingDismissalRequestIds, storePendingDismissalRequest } from "./monitoring-dismissal-request";

const instant = "2026-10-01T15:00:00.000Z";
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "33333333-3333-4333-8333-333333333333";
const thirdId = "44444444-4444-4444-8444-444444444444";
const siteId = "22222222-2222-4222-8222-222222222222";
function incident(id: string, site = siteId, isRead = false) {
  return { id, siteId: site, type: "gateway_offline", status: "open", targetKey: `gateway:${id}`,
    fixtureId: null, gatewayId: id, openedAt: instant, lastObservedAt: instant, acknowledgedAt: null,
    acknowledgedByUserId: null, assignedToUserId: null, resolvedAt: null, resolvedByUserId: null,
    resolutionKind: null, resolutionNote: null, createdAt: instant, updatedAt: instant,
    acknowledgedBy: null, assignedTo: null, resolvedBy: null,
    target: { kind: "gateway", id, name: `Gateway ${id.slice(0, 4)}` }, isRead, readAt: isRead ? instant : null,
    isDismissed: false, dismissedAt: null };
}
let client: QueryClient;
// Vitest 4's unparameterized mock also admits constructors; this fixture is
// specifically the callable fetch adapter used by the incident API.
let fetchSpy: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Response | Promise<Response>>>;
let unread: number;
let receipts: Set<string>;
let failRead: boolean;
let failGet: boolean;
let active: boolean;
let visible: boolean;
const observers: Observer[] = [];
class Observer {
  elements = new Set<Element>();
  constructor(public callback: IntersectionObserverCallback) { observers.push(this); }
  observe(element: Element) { this.elements.add(element); }
  unobserve(element: Element) { this.elements.delete(element); }
  disconnect() { this.elements.clear(); }
  takeRecords() { return []; }
  root = null; rootMargin = "0px"; thresholds = [0];
  show(id: string, visible = true) {
    const target = [...this.elements].find(element => element.getAttribute("data-alarm-id") === id);
    if (target) this.callback([{ target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
beforeEach(() => {
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  unread = 3; receipts = new Set(); failRead = false; failGet = false; active = true; visible = true; observers.length = 0;
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.spyOn(document, "hasFocus").mockImplementation(() => active);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
  fetchSpy = vi.fn(async (path: string, init: RequestInit = {}) => {
    if (init.method === "PUT") {
      if (failRead) return Response.json({ message: "private reason" }, { status: 503 });
      const id = path.split("/").at(-2)!;
      if (!receipts.has(id)) { receipts.add(id); unread--; }
      return Response.json({ incidentId: id, isRead: true, readAt: instant });
    }
    if (failGet) return Response.json({}, { status: 503 });
    const url = new URL(path, "http://test");
    const site = path.split("/")[3];
    const ids = url.searchParams.has("cursor") ? [thirdId] : url.searchParams.get("limit") === "1" ? [firstId] : [firstId, secondId];
    return Response.json({ incidents: ids.map(id => incident(id, site, receipts.has(id))), unreadCount: unread, activeCount: 3,
      nextCursor: url.searchParams.has("cursor") ? null : "next_page" });
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const puts = () => fetchSpy.mock.calls.filter(([, init]) => init?.method === "PUT");
function show(id: string, visible = true) { act(() => observers.forEach(observer => observer.show(id, visible))); }
function center() {
  return <SessionStatusProvider><SessionStatusCenter userId="user-1" siteId={siteId} timeZone="Asia/Seoul" /></SessionStatusProvider>;
}

describe("persistent alarm center", () => {
  it("recovers an alphabetic uppercase saved UUID across reload and removes only its original durable entry", async () => {
    const scope = { userId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", siteId };
    const savedKey = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF";
    const aliasKey = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const otherKey = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const otherScope = { ...scope, siteId: "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa" };
    storePendingDismissalRequest(scope, savedKey, localStorage);
    storePendingDismissalRequest(scope, aliasKey, localStorage);
    storePendingDismissalRequest(scope, otherKey, localStorage);
    storePendingDismissalRequest(otherScope, savedKey, localStorage);
    localStorage.setItem("unrelated-preference", "keep");
    const original = fetchSpy.getMockImplementation()!;
    let available = false;
    fetchSpy.mockImplementation(async (path, init) => init?.method === "POST"
      ? available ? Response.json({ siteId, clientRequestId: "abcdefab-cdef-4abc-8def-abcdefabcdef", snapshotAt: instant, dismissedCount: 2 }) : Response.json({}, { status: 503 })
      : original(path, init));
    const first = renderHook(() => useMonitoringIncidents(scope.userId, siteId, true), { wrapper });
    await waitFor(() => expect(first.result.current.pendingDismissalRequestIds).toContain(savedKey));
    const posts = () => fetchSpy.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts()).toHaveLength(0);
    await act(async () => { await first.result.current.dismissAll(savedKey); });
    expect(first.result.current.bulkError).toContain("결과를 확인하지 못했습니다");
    expect(listPendingDismissalRequestIds(scope, localStorage)).toContain(savedKey);
    first.unmount(); client.clear();
    available = true;
    const reloaded = renderHook(() => useMonitoringIncidents(scope.userId, siteId, true), { wrapper });
    await waitFor(() => expect(reloaded.result.current.pendingDismissalRequestIds).toContain(savedKey));
    expect(posts()).toHaveLength(1);
    await act(async () => { await reloaded.result.current.dismissAll(savedKey); });
    expect(reloaded.result.current.bulkError).toBe("");
    expect(reloaded.result.current.pendingDismissalRequestIds).toEqual([aliasKey, otherKey]);
    expect(listPendingDismissalRequestIds(scope, localStorage)).toEqual([aliasKey, otherKey]);
    expect(listPendingDismissalRequestIds(otherScope, localStorage)).toEqual([savedKey]);
    expect(localStorage.getItem("unrelated-preference")).toBe("keep");
    expect(posts()).toHaveLength(2);
    expect(posts().map(([, init]) => JSON.parse(init!.body as string))).toEqual([{ clientRequestId: savedKey }, { clientRequestId: savedKey }]);
    expect(posts().every(([path]) => path === `/api/sites/${siteId}/monitoring-incidents/dismiss-all`)).toBe(true);
    expect(puts()).toHaveLength(0);
    expect(receipts.size).toBe(0);
  });
  it("stops before bulk POST if durable storage fails", async () => {
    const user = "00000000-0000-4000-8000-000000000001";
    const { result } = renderHook(() => useMonitoringIncidents(user, siteId, true), { wrapper });
    await waitFor(() => expect(result.current.incidents).toHaveLength(2));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await act(async () => { await result.current.dismissAll(); });
    expect(result.current.bulkError).toContain("저장하지 못했습니다");
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(result.current.incidents).toHaveLength(2);
    expect(result.current.unreadCount).toBe(3);
    expect(receipts.size).toBe(0);
  });

  it("recovers multiple independent pending keys explicitly and isolates a late bulk response", async () => {
    const user = "00000000-0000-4000-8000-000000000001";
    const scope = { userId: user, siteId };
    const key = "00000000-0000-4000-8000-000000000003";
    const otherKey = "00000000-0000-4000-8000-000000000004";
    const otherSite = "00000000-0000-4000-8000-000000000005";
    storePendingDismissalRequest(scope, key, localStorage);
    storePendingDismissalRequest(scope, otherKey, localStorage);
    storePendingDismissalRequest({ ...scope, siteId: otherSite }, key, localStorage);
    let resolve!: (response: Response) => void;
    const original = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation((path, init) => init?.method === "POST" ? new Promise<Response>(done => { resolve = done; }) : original(path, init));
    const { result, rerender } = renderHook(({ site }) => useMonitoringIncidents(user, site, true), { wrapper, initialProps: { site: siteId } });
    await waitFor(() => expect(result.current.pendingDismissalRequestIds).toEqual([key, otherKey]));
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.dismissAll(key); });
    await waitFor(() => expect(result.current.bulkPending).toBe(true));
    rerender({ site: otherSite });
    await waitFor(() => expect(result.current.incidents[0]?.siteId).toBe(otherSite));
    const calls = fetchSpy.mock.calls.length;
    await act(async () => { resolve(Response.json({ siteId, clientRequestId: key, snapshotAt: instant, dismissedCount: 2 })); await pending; });
    expect(result.current.incidents).toHaveLength(2);
    expect(result.current.unreadCount).toBe(3);
    expect(result.current.pendingDismissalRequestIds).toEqual([key]);
    // The caller's abort makes the old response unconfirmed; its key must
    // remain recoverable even when the synthetic server completed the work.
    expect(listPendingDismissalRequestIds(scope, localStorage)).toEqual([key, otherKey]);
    expect(fetchSpy.mock.calls).toHaveLength(calls);
    expect(receipts.size).toBe(0);
  });

  it("requeries first page and badge only after confirmed individual hiding", async () => {
    const { result } = renderHook(() => useMonitoringIncidents("user-1", siteId, true), { wrapper });
    await waitFor(() => expect(result.current.incidents).toHaveLength(2));
    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.incidents).toHaveLength(3));
    let hidden = false;
    fetchSpy.mockImplementation(async (path, init) => {
      if (init?.method === "PUT") { hidden = true; return Response.json({ incidentId: firstId, isDismissed: true, dismissedAt: instant }); }
      return Response.json({ incidents: hidden ? [incident(secondId)] : [incident(firstId), incident(secondId)], unreadCount: hidden ? 2 : 3, activeCount: 3, nextCursor: null });
    });
    await act(async () => { await result.current.dismiss(firstId); });
    await waitFor(() => expect(result.current.incidents.map(row => row.id)).toEqual([secondId]));
    expect(result.current.unreadCount).toBe(2);
    expect(receipts.size).toBe(0);
    expect(puts()).toHaveLength(1);
    expect(puts()[0][0]).toContain(`/${firstId}/dismiss`);
  });
  it("personal hiding preserves unread rows on failure and never invokes read or control", async () => {
    render(center(), { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "알람센터, 미읽음 3건" }));
    const row = (await screen.findByText("Gateway 1111")).closest("li")!;
    fetchSpy.mockImplementation(async (path: string) => path.endsWith("/dismiss")
      ? Response.json({}, { status: 503 })
      : Response.json({ incidents: [incident(firstId), incident(secondId)], unreadCount: 3, activeCount: 3, nextCursor: null }));
    fireEvent.click(within(row).getByRole("button", { name: "지우기" }));
    expect(await within(row).findByText(/지우지 못했습니다/)).toBeVisible();
    expect(row).toHaveTextContent("미읽음");
    expect(receipts.size).toBe(0);
    expect(puts().every(([path]) => path.endsWith("/dismiss"))).toBe(true);
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("bulk retry preserves request key across reload and ignores late scope responses", async () => {
    const user = "00000000-0000-4000-8000-000000000001";
    const first = render(<SessionStatusProvider><SessionStatusCenter userId={user} siteId={siteId} /></SessionStatusProvider>, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "알람센터, 미읽음 3건" }));
    await screen.findByText("Gateway 1111");
    const original = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path.endsWith("/dismiss-all")) {
        expect(localStorage.length).toBeGreaterThan(0);
        return Response.json({}, { status: 503 });
      }
      return original(path, init);
    });
    fireEvent.click(screen.getByRole("button", { name: "전체 지우기" }));
    const confirm = screen.getByRole("alertdialog", { name: "전체 알람 지우기" });
    expect(confirm).toHaveTextContent(/페이지.*필터/);
    fireEvent.click(within(confirm).getByRole("button", { name: "전체 지우기" }));
    await screen.findByText(/전체 지우기 결과를 확인하지 못했습니다/);
    const posts = () => fetchSpy.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts()).toHaveLength(1);
    // The POST predicate above guarantees RequestInit for these typed accesses.
    const key = JSON.parse(posts()[0][1]!.body as string).clientRequestId;
    first.unmount(); client.clear();
    render(<SessionStatusProvider><SessionStatusCenter userId={user} siteId={siteId} /></SessionStatusProvider>, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "알람센터, 미읽음 3건" }));
    await screen.findByText("Gateway 1111");
    expect(posts()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /결과 확인.*다시 시도/ }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(JSON.parse(posts()[1][1]!.body as string)).toEqual({ clientRequestId: key });
    expect(receipts.size).toBe(0);
  });
  it("closed_hidden_next_page_alarms_are_not_read", async () => {
    render(center(), { wrapper });
    const trigger = await screen.findByRole("button", { name: "알람센터, 미읽음 3건" });
    expect(fetchSpy.mock.calls[0][0]).toBe(`/api/sites/${siteId}/monitoring-incidents?limit=1&view=personal`);
    expect(puts()).toHaveLength(0);
    fireEvent.click(trigger);
    await screen.findByText("Gateway 1111");
    expect(fetchSpy.mock.calls.some(([path]) => path === `/api/sites/${siteId}/monitoring-incidents?limit=25&view=personal`)).toBe(true);
    show(firstId, false); show(thirdId);
    expect(puts()).toHaveLength(0);
    visible = false;
    fireEvent(document, new Event("visibilitychange"));
    show(firstId);
    expect(puts()).toHaveLength(0);
    visible = true;
    fireEvent(document, new Event("visibilitychange"));
    active = false;
    fireEvent(window, new Event("blur"));
    show(firstId);
    expect(puts()).toHaveLength(0);
    active = true;
    fireEvent(window, new Event("focus"));
    show(firstId);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][0]).toBe(`/api/sites/${siteId}/monitoring-incidents/${firstId}/read`);
    fireEvent.click(screen.getByRole("button", { name: "알람센터 닫기" }));
    show(secondId);
    expect(puts()).toHaveLength(1);
  });

  it("visible_read_succeeds_refetches_and_failure_preserves_badge", async () => {
    render(center(), { wrapper });
    const trigger = await screen.findByRole("button", { name: "알람센터, 미읽음 3건" });
    fireEvent.click(trigger);
    await screen.findByText("Gateway 1111");
    failRead = true;
    show(firstId);
    expect(await screen.findByText("읽음 저장 실패" )).toBeVisible();
    expect(trigger).toHaveAttribute("aria-label", "알람센터, 미읽음 3건");
    show(firstId);
    expect(puts()).toHaveLength(1);
    failRead = false;
    fireEvent.click(screen.getByRole("button", { name: "읽음 저장 다시 시도" }));
    await waitFor(() => expect(trigger).toHaveAttribute("aria-label", "알람센터, 미읽음 2건"));
    expect(screen.getByText("Gateway 1111")).toBeVisible();
    expect(screen.getByText("읽음")).toBeVisible();
    show(firstId);
    await act(async () => { await client.invalidateQueries({ queryKey: ["monitoring-incidents", "user-1", siteId] }); });
    show(firstId);
    expect(puts()).toHaveLength(2);
    failGet = true;
    await act(async () => { await client.invalidateQueries({ queryKey: ["monitoring-incidents", "user-1", siteId] }); });
    expect(await screen.findByText(/알람 갱신 실패/)).toBeVisible();
    expect(trigger).toHaveAttribute("aria-label", "알람센터, 미읽음 2건, 갱신 실패");
  });

  it.each(["account", "site"])("account_site_switch_discards_late_read: %s", async (change) => {
    const { result, rerender } = renderHook(({ user, site }) => useMonitoringIncidents(user, site, true),
      { wrapper, initialProps: { user: "user-1", site: siteId } });
    await waitFor(() => expect(result.current.incidents).toHaveLength(2));
    let resolve!: (response: Response) => void;
    const original = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation((path, init) => init?.method === "PUT" ? new Promise<Response>(done => { resolve = done; }) : original(path, init));
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.markRead(firstId); });
    const nextSite = change === "site" ? "55555555-5555-4555-8555-555555555555" : siteId;
    rerender({ user: change === "account" ? "user-2" : "user-1", site: nextSite });
    await waitFor(() => expect(result.current.incidents[0]?.siteId).toBe(nextSite));
    const calls = fetchSpy.mock.calls.length;
    await act(async () => { resolve(Response.json({ incidentId: firstId, isRead: true, readAt: instant })); await pending; });
    expect(result.current.unreadCount).toBe(3);
    expect(result.current.incidents[0].isRead).toBe(false);
    expect(fetchSpy.mock.calls).toHaveLength(calls);
  });

  it("deduplicates in-flight reads and preserves counts until the canonical GET succeeds", async () => {
    const { result } = renderHook(() => useMonitoringIncidents("user-1", siteId, true), { wrapper });
    await waitFor(() => expect(result.current.unreadCount).toBe(3));
    let resolve!: (response: Response) => void;
    fetchSpy.mockImplementation((path, init) => init?.method === "PUT" ? new Promise<Response>(done => { resolve = done; }) : Response.json({ incidents: [incident(firstId, siteId, true)], unreadCount: 2, activeCount: 3, nextCursor: null }));
    let first!: Promise<unknown>; let duplicate!: Promise<unknown>;
    act(() => { first = result.current.markRead(firstId); duplicate = result.current.markRead(firstId); });
    expect(puts()).toHaveLength(1);
    expect(result.current.unreadCount).toBe(3);
    await act(async () => { resolve(Response.json({ incidentId: firstId, isRead: true, readAt: instant })); await Promise.all([first, duplicate]); });
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
  });

  it("does not let a delayed closed GET overwrite the post-read canonical count", async () => {
    let resolveSummary!: (response: Response) => void;
    let summarySignal!: AbortSignal;
    const original = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation((path: string, init: RequestInit = {}) => {
      if (path.endsWith("?limit=1&view=personal")) {
        summarySignal = init.signal!;
        return new Promise<Response>(resolve => { resolveSummary = resolve; });
      }
      return original(path, init);
    });
    const { result, rerender } = renderHook(({ open }) => useMonitoringIncidents("user-1", siteId, open),
      { wrapper, initialProps: { open: false } });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    rerender({ open: true });
    await waitFor(() => expect(result.current.unreadCount).toBe(3));
    await act(async () => { await result.current.markRead(firstId); });
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
    expect(result.current.incidents[0].isRead).toBe(true);

    await act(async () => { resolveSummary(Response.json({ incidents: [incident(firstId)], unreadCount: 3, activeCount: 3, nextCursor: null })); });
    await waitFor(() => expect(client.isFetching({ queryKey: ["monitoring-incidents", "user-1", siteId] })).toBe(0));
    expect(result.current.unreadCount).toBe(2);
    expect(result.current.isStale).toBe(false);
    expect(summarySignal.aborted).toBe(true);
  });

  it("cancels a superseded open GET when the closed summary becomes canonical", async () => {
    let resolveList!: (response: Response) => void;
    let listSignal!: AbortSignal;
    const original = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation((path: string, init: RequestInit = {}) => {
      if (path.endsWith("?limit=25&view=personal")) {
        listSignal = init.signal!;
        return new Promise<Response>(resolve => { resolveList = resolve; });
      }
      return original(path, init);
    });
    const { result, rerender } = renderHook(({ open }) => useMonitoringIncidents("user-1", siteId, open),
      { wrapper, initialProps: { open: true } });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    unread = 2;
    rerender({ open: false });
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
    await act(async () => { resolveList(Response.json({ incidents: [incident(firstId)], unreadCount: 3, activeCount: 3, nextCursor: null })); });
    await waitFor(() => expect(client.isFetching({ queryKey: ["monitoring-incidents", "user-1", siteId] })).toBe(0));
    expect(result.current.unreadCount).toBe(2);
    expect(listSignal.aborted).toBe(true);
  });

  it("accepts future canonical increases and device decreases but preserves stale counts on the newest GET failure", async () => {
    const { result, rerender } = renderHook(({ open }) => useMonitoringIncidents("user-1", siteId, open),
      { wrapper, initialProps: { open: true } });
    await waitFor(() => expect(result.current.unreadCount).toBe(3));
    await act(async () => { await result.current.markRead(firstId); });
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
    unread = 3;
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.unreadCount).toBe(3));
    receipts.add(secondId); unread = 1;
    rerender({ open: false });
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    failGet = true;
    rerender({ open: true });
    await waitFor(() => expect(result.current.isStale).toBe(true));
    expect(result.current.error).not.toBeNull();
    expect(result.current.unreadCount).toBe(1);
    failGet = false; unread = 5;
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.unreadCount).toBe(5));
    expect(result.current.isStale).toBe(false);
  });

  it("orders independently refreshed mode snapshots by request start rather than late completion", async () => {
    const { result, rerender } = renderHook(({ open }) => useMonitoringIncidents("user-1", siteId, open),
      { wrapper, initialProps: { open: false } });
    await waitFor(() => expect(result.current.unreadCount).toBe(3));
    rerender({ open: true });
    await waitFor(() => expect(result.current.incidents).toHaveLength(2));
    let resolveSummary!: (response: Response) => void;
    const original = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation((path: string, init: RequestInit = {}) => path.endsWith("?limit=1&view=personal")
      ? new Promise<Response>(resolve => { resolveSummary = resolve; }) : original(path, init));
    let refresh!: Promise<unknown>;
    // Keep both real query functions: independently refreshing an existing
    // cached mode must not give its older request authority by finishing last.
    act(() => { refresh = client.fetchQuery({ queryKey: ["monitoring-incidents", "user-1", siteId, "personal", "all", null, "summary"] }); });
    await waitFor(() => expect(resolveSummary).toBeTypeOf("function"));
    receipts.add(firstId); unread = 2;
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
    const beforeLateResponse = result.current;
    await act(async () => { resolveSummary(Response.json({ incidents: [incident(firstId)], unreadCount: 3, activeCount: 3, nextCursor: null })); await refresh; });
    // Await the real observer's render, not just the fetch promise: React Query
    // schedules notifications after it accepts a response into the cache.
    await waitFor(() => expect(result.current).not.toBe(beforeLateResponse));
    expect(result.current.unreadCount).toBe(2);
    expect(result.current.incidents[0].isRead).toBe(true);
    expect(result.current.isStale).toBe(false);
  });

  it("continues canonical ordering when StrictMode remount reuses both query caches", async () => {
    const strictWrapper = ({ children }: PropsWithChildren) => <StrictMode>{wrapper({ children })}</StrictMode>;
    const first = renderHook(({ open }) => useMonitoringIncidents("user-1", siteId, open),
      { wrapper: strictWrapper, initialProps: { open: false } });
    await waitFor(() => expect(first.result.current.unreadCount).toBe(3));
    first.rerender({ open: true });
    await waitFor(() => expect(first.result.current.incidents).toHaveLength(2));
    await act(async () => { await first.result.current.markRead(firstId); });
    await waitFor(() => expect(first.result.current.unreadCount).toBe(2));
    first.unmount();
    unread = 4;
    const second = renderHook(() => useMonitoringIncidents("user-1", siteId, false), { wrapper: strictWrapper });
    await waitFor(() => expect(second.result.current.unreadCount).toBe(4));
    expect(puts()).toHaveLength(1);
    expect(second.result.current.isStale).toBe(false);
  });

  it.each(["account", "site"])("does not accept a delayed GET from the old %s", async change => {
    let resolveOld!: (response: Response) => void;
    const original = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve; }));
    const { result, rerender } = renderHook(({ user, site }) => useMonitoringIncidents(user, site, false),
      { wrapper, initialProps: { user: "user-1", site: siteId } });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    fetchSpy.mockImplementation(original);
    unread = 1;
    rerender({ user: change === "account" ? "user-2" : "user-1", site: change === "site" ? "55555555-5555-4555-8555-555555555555" : siteId });
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    await act(async () => { resolveOld(Response.json({ incidents: [incident(firstId)], unreadCount: 3, activeCount: 3, nextCursor: null })); });
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.isStale).toBe(false);
  });

  it("pages by server cursor without marking fetched unseen rows", async () => {
    const { result } = renderHook(() => useMonitoringIncidents("user-1", siteId, true), { wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.incidents).toHaveLength(3));
    expect(fetchSpy.mock.calls.some(([path]) => path === `/api/sites/${siteId}/monitoring-incidents?limit=25&cursor=next_page&view=personal`)).toBe(true);
    expect(puts()).toHaveLength(0);
  });

  it("refreshes canonical server state after returning to an active document", async () => {
    const { result } = renderHook(() => useMonitoringIncidents("user-1", siteId, false), { wrapper });
    await waitFor(() => expect(result.current.unreadCount).toBe(3));
    unread = 1;
    active = false; fireEvent(window, new Event("blur"));
    active = true; fireEvent(window, new Event("focus"));
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    expect(puts()).toHaveLength(0);
  });

  it("transient_status_actions_are_not_alarm_count", async () => {
    const retry = vi.fn();
    function Status() {
      const items = useMemo(() => [{ id: "command", fingerprint: "pending", source: "command" as const,
        tone: "info" as const, title: "명령 진행 중", action: { label: "다시 시도", onAction: retry } }], []);
      useSessionStatus("screen", items);
      return <SessionStatusCenter userId="user-1" siteId={siteId} />;
    }
    render(<SessionStatusProvider><Status /></SessionStatusProvider>, { wrapper });
    const trigger = await screen.findByRole("button", { name: "알람센터, 미읽음 3건" });
    fireEvent.click(trigger);
    const region = await screen.findByRole("region", { name: "현재 화면 상태" });
    expect(region).toHaveTextContent("명령 진행 중");
    fireEvent.click(within(region).getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(trigger).toHaveAttribute("aria-label", "알람센터, 미읽음 3건");
  });

  it("survives StrictMode effect replay and reloads persisted personal read state on a new session", async () => {
    const strictWrapper = ({ children }: PropsWithChildren) => <StrictMode>{wrapper({ children })}</StrictMode>;
    const first = renderHook(() => useMonitoringIncidents("user-1", siteId, true), { wrapper: strictWrapper });
    await waitFor(() => expect(first.result.current.unreadCount).toBe(3));
    await act(async () => { await first.result.current.markRead(firstId); });
    await waitFor(() => expect(first.result.current.unreadCount).toBe(2));
    first.unmount();
    client.clear();
    const second = renderHook(() => useMonitoringIncidents("user-1", siteId, true), { wrapper: strictWrapper });
    await waitFor(() => expect(second.result.current.incidents[0]?.isRead).toBe(true));
    await act(async () => { await second.result.current.markRead(firstId); });
    expect(puts()).toHaveLength(1);
  });

  it("labels an initial GET failure as unknown without creating a zero badge", async () => {
    failGet = true;
    render(center(), { wrapper });
    const trigger = await screen.findByRole("button", { name: "알람센터, 확인 불가" });
    expect(within(trigger).getByTestId("alarm-unread-badge")).toHaveTextContent("?");
    fireEvent.click(trigger);
    expect(await screen.findByText(/알람 확인 불가/)).toBeVisible();
    expect(puts()).toHaveLength(0);
  });

  it("clears a failed read after a canonical GET confirms the receipt from another device", async () => {
    render(center(), { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "알람센터, 미읽음 3건" }));
    await screen.findByText("Gateway 1111");
    failRead = true;
    show(firstId);
    await screen.findByText("읽음 저장 실패");
    receipts.add(firstId);
    unread = 2;
    await act(async () => { await client.invalidateQueries({ queryKey: ["monitoring-incidents", "user-1", siteId] }); });
    expect(await screen.findByText("읽음", { exact: true })).toBeVisible();
    await waitFor(() => expect(screen.queryByText("읽음 저장 실패")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "읽음 저장 다시 시도" })).not.toBeInTheDocument();
    expect(puts()).toHaveLength(1);
  });
});

function RecentPublish() {
  const toast = useSessionToast();
  return <button onClick={() => toast.publish({ title: "작업 저장", tone: "success" })}>최근 알림 추가</button>;
}
it("sums mobile server and recent unread while reading recent does not resolve incidents", async () => {
  render(<SessionStatusProvider><RecentPublish /><SessionStatusCenter compact userId="user-1" siteId={siteId} /></SessionStatusProvider>, { wrapper });
  await screen.findByRole("button", { name: "알람센터, 미읽음 3건 (현장 알람과 최근 알림)" });
  fireEvent.click(screen.getByText("최근 알림 추가"));
  fireEvent.click(screen.getByRole("button", { name: "알람센터, 미읽음 4건 (현장 알람과 최근 알림)" }));
  fireEvent.click(screen.getByRole("button", { name: "읽음으로 표시" }));
  expect(screen.getByLabelText("알람센터, 미읽음 3건 (현장 알람과 최근 알림)" )).toBeInTheDocument();
  await screen.findByText("Gateway 1111");
  expect(puts()).toHaveLength(0); expect(screen.getAllByText("미해결")).toHaveLength(2);
});
it("does not replace unknown server count with local unread zero", async () => {
  failGet = true;
  render(<SessionStatusProvider><RecentPublish /><SessionStatusCenter compact userId="user-1" siteId={siteId} /></SessionStatusProvider>, { wrapper });
  fireEvent.click(screen.getByText("최근 알림 추가"));
  const trigger = await screen.findByRole("button", { name: "알람센터, 확인 불가" });
  expect(within(trigger).getByTestId("alarm-unread-badge")).toHaveTextContent("?");
});
