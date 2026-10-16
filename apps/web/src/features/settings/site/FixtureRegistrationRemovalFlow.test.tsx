import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStatusProvider, ToastRegion } from "../../../components/ui";
import type { FixtureRegistrationRemovalPreview, FixtureRegistrationRemovalView, FixtureRegistrationRemovalStatus } from "@led-control/shared/fixture-registration-removal-contracts";
import { FixtureRegistrationRemovalFlow, type FixtureRemovalTarget } from "./FixtureRegistrationRemovalFlow";

const siteId = "11111111-1111-4111-8111-111111111111";
const floorId = "22222222-2222-4222-8222-222222222222";
const fixtureId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const instant = "2026-10-16T00:00:00.000Z";
const fixture = { id: fixtureId, name: "입구 조명", serialNumber: "BIO-0001", ratedWatt: 40, updatedAt: instant, deviceUuid: "bio:aabbccddeeff", meshAddress: "0x0001", firmwareVersion: "1" };
const preview: FixtureRegistrationRemovalPreview = { fixtureId, fixtureName: fixture.name, serialNumber: fixture.serialNumber,
  expectedUpdatedAt: instant, allowed: true, blockedReasons: [] };
const view: FixtureRegistrationRemovalView = { operationId, siteId, floorId, fixtureId, status: "pending", errorCode: null, createdAt: instant, completedAt: null };
let currentPreview: FixtureRegistrationRemovalPreview;
let currentView: FixtureRegistrationRemovalView | null;
let posts: Array<{ clientRequestId: string; expectedUpdatedAt: string }>;
let requests: Array<{ path: string; method: string }>;
let failPost: boolean;
let failGet: boolean;
let postBarrier: Promise<Response> | undefined;
let getBarrier: Promise<Response> | undefined;
let previewBarrier: Promise<Response> | undefined;
let failPreview: boolean;

beforeEach(() => {
  sessionStorage.clear(); posts = []; requests = []; failPost = false; failGet = false;
  postBarrier = undefined; getBarrier = undefined; previewBarrier = undefined; failPreview = false;
  currentPreview = structuredClone(preview); currentView = structuredClone(view);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url); const method = init.method ?? "GET";
    requests.push({ path, method });
    if (path.endsWith("registration-removal-preview")) return failPreview
      ? Response.json({ message: "unavailable" }, { status: 503 }) : previewBarrier ?? Response.json(currentPreview);
    if (method === "POST") {
      posts.push(JSON.parse(init.body as string));
      if (failPost) throw new TypeError("lost response");
      return postBarrier ?? Response.json(currentView, { status: 202 });
    }
    if (failGet) return Response.json({ message: "unavailable" }, { status: 503 });
    return getBarrier ?? Response.json(currentView);
  }));
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mount(site = siteId, principal = "admin:org") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Harness({ selectedSite, selectedPrincipal }: { selectedSite: string; selectedPrincipal: string }) {
    const [target, setTarget] = useState<FixtureRemovalTarget | null>(null);
    return <QueryClientProvider client={client}><SessionStatusProvider scope={`${selectedPrincipal}:${selectedSite}`}>
      <button onClick={event => setTarget({ siteId: selectedSite, floorId, fixture, trigger: event.currentTarget })}>삭제 열기</button>
      <FixtureRegistrationRemovalFlow key={`${selectedPrincipal}:${selectedSite}`} siteId={selectedSite} principal={selectedPrincipal}
        target={target?.siteId === selectedSite ? target : null} onClose={() => setTarget(null)} />
      <ToastRegion />
    </SessionStatusProvider></QueryClientProvider>;
  }
  const result = render(<Harness selectedSite={site} selectedPrincipal={principal} />);
  return { ...result, client, switchScope: (selectedSite: string, selectedPrincipal = principal) => result.rerender(<Harness selectedSite={selectedSite} selectedPrincipal={selectedPrincipal} />) };
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "삭제 열기" }));
  const dialog = await screen.findByRole("alertdialog", { name: "조명 등록 삭제" });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "등록 삭제" })).toBeEnabled());
  return dialog;
}
async function submit() {
  const dialog = await open(); fireEvent.click(within(dialog).getByRole("button", { name: "등록 삭제" }));
  await waitFor(() => expect(posts).toHaveLength(1));
}

describe("registration removal safety and recovery", () => {
  it("shows exact identity, preserved history and no-reset/no-off warning; cancellation sends zero mutations", async () => {
    mount(); const dialog = await open();
    expect(dialog).toHaveTextContent("입구 조명"); expect(dialog).toHaveTextContent("BIO-0001");
    expect(dialog).toHaveTextContent("공장 초기화"); expect(dialog).toHaveTextContent("소등");
    expect(dialog).toHaveTextContent("통계"); expect(dialog).toHaveTextContent("제어 이력");
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(posts).toEqual([]); expect(sessionStorage.length).toBe(0);
    await waitFor(() => expect(screen.getByRole("button", { name: "삭제 열기" })).toHaveFocus());
  });

  it("lists every blocker and disallows confirmation", async () => {
    currentPreview = { ...preview, allowed: false, blockedReasons: [
      { code: "GATEWAY_OFFLINE", message: "Gateway 연결을 확인하세요." },
      { code: "GROUP_MEMBERSHIP", message: "입구 구역에서 먼저 제외하세요." }
    ] };
    mount(); fireEvent.click(screen.getByRole("button", { name: "삭제 열기" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText("Gateway 연결을 확인하세요.")).toBeVisible();
    expect(dialog).toHaveTextContent("입구 구역에서 먼저 제외하세요.");
    expect(within(dialog).getByRole("button", { name: "등록 삭제" })).toBeDisabled();
    expect(posts).toEqual([]);
  });

  it("persists the request before sending and deduplicates double clicks", async () => {
    let finish!: (response: Response) => void;
    postBarrier = new Promise(resolve => { finish = resolve; });
    mount(); const dialog = await open(); const confirm = within(dialog).getByRole("button", { name: "등록 삭제" });
    try {
      fireEvent.click(confirm); fireEvent.click(confirm);
      await waitFor(() => expect(posts).toHaveLength(1));
      const saved = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.getItem(sessionStorage.key(i)!)).join("");
      expect(saved).toContain(posts[0].clientRequestId); expect(saved).toContain(instant);
      expect(saved).toContain("admin:org"); expect(saved).toContain(fixtureId);
      expect(posts[0]).toEqual({ clientRequestId: expect.any(String), expectedUpdatedAt: instant });
    } finally { await act(async () => finish(Response.json(view, { status: 202 }))); }
    expect(screen.queryByText("조명 등록을 삭제했습니다.")).not.toBeInTheDocument();
  });

  it("uses the confirmation-time preview timestamp when telemetry alone changed since the card loaded", async () => {
    mount(); const dialog = await open();
    const freshTimestamp = "2026-10-16T00:00:00.170Z";
    currentPreview = { ...preview, expectedUpdatedAt: freshTimestamp };
    fireEvent.click(within(dialog).getByRole("button", { name: "등록 삭제" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].expectedUpdatedAt).toBe(freshTimestamp);
    expect(requests.filter(request => request.path.endsWith("registration-removal-preview"))).toHaveLength(2);
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toContain(freshTimestamp);
  });

  it.each(["fixtureName", "serialNumber"] as const)("requires explicit reconfirmation when fresh %s differs from the displayed identity", async field => {
    mount(); const dialog = await open();
    currentPreview = { ...preview, [field]: "변경된 장치 정보", expectedUpdatedAt: "2026-10-16T00:00:00.180Z" };
    fireEvent.click(within(dialog).getByRole("button", { name: "등록 삭제" }));
    expect(await within(dialog).findByText("변경된 장치 정보")).toBeVisible();
    expect(dialog).toHaveTextContent("변경된 이름과 시리얼을 확인한 뒤 다시 등록 삭제를 눌러 주세요.");
    expect(posts).toEqual([]); expect(sessionStorage.length).toBe(0);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "등록 삭제" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "등록 삭제" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].expectedUpdatedAt).toBe("2026-10-16T00:00:00.180Z");
  });

  it("does not submit when the fresh confirmation preview becomes blocked", async () => {
    mount(); const dialog = await open();
    currentPreview = { ...preview, allowed: false, blockedReasons: [{ code: "GATEWAY_OFFLINE", message: "지금 Gateway가 오프라인입니다." }] };
    fireEvent.click(within(dialog).getByRole("button", { name: "등록 삭제" }));
    expect(await within(dialog).findByText("지금 Gateway가 오프라인입니다.")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "등록 삭제" })).toBeDisabled();
    expect(posts).toEqual([]); expect(sessionStorage.length).toBe(0);
  });

  it("does not submit when the fresh confirmation preview fails", async () => {
    mount(); const dialog = await open(); failPreview = true;
    fireEvent.click(within(dialog).getByRole("button", { name: "등록 삭제" }));
    expect(await within(dialog).findByText("최종 삭제 가능 여부를 확인하지 못했습니다. 다시 확인해 주세요.")).toBeVisible();
    expect(posts).toEqual([]); expect(sessionStorage.length).toBe(0);
  });

  it("deduplicates confirmation reads and cancellation during that read sends zero mutations", async () => {
    mount(); const dialog = await open();
    let finish!: (response: Response) => void;
    previewBarrier = new Promise(resolve => { finish = resolve; });
    try {
      const confirm = within(dialog).getByRole("button", { name: "등록 삭제" });
      fireEvent.click(confirm); fireEvent.click(confirm);
      await waitFor(() => expect(requests.filter(request => request.path.endsWith("registration-removal-preview"))).toHaveLength(2));
      fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    } finally { await act(async () => finish(Response.json(currentPreview))); }
    expect(posts).toEqual([]); expect(sessionStorage.length).toBe(0);
  });

  it("ignores a fresh confirmation preview after switching sites", async () => {
    const { switchScope } = mount(); const dialog = await open();
    let finish!: (response: Response) => void;
    previewBarrier = new Promise(resolve => { finish = resolve; });
    try {
      fireEvent.click(within(dialog).getByRole("button", { name: "등록 삭제" }));
      await waitFor(() => expect(requests.filter(request => request.path.endsWith("registration-removal-preview"))).toHaveLength(2));
      switchScope("66666666-6666-4666-8666-666666666666");
    } finally { await act(async () => finish(Response.json(currentPreview))); }
    expect(posts).toEqual([]); expect(sessionStorage.length).toBe(0);
  });

  it.each<FixtureRegistrationRemovalStatus>(["pending", "gateway_confirmed", "reconcile_required", "rejected"])("does not invalidate or toast success for %s", async status => {
    currentView = { ...view, status, errorCode: status === "rejected" || status === "reconcile_required" ? "BLOCKED" : null };
    const { client } = mount(); const invalidation = vi.spyOn(client, "invalidateQueries");
    await submit();
    await screen.findByRole("region", { name: "등록 삭제 작업" });
    expect(invalidation).not.toHaveBeenCalled();
    expect(screen.queryByText("조명 등록을 삭제했습니다.")).not.toBeInTheDocument();
    if (status === "reconcile_required") {
      expect(screen.getByText("결과 재조정 필요")).toBeVisible();
      expect(screen.queryByRole("button", { name: "같은 요청 다시 보내기" })).not.toBeInTheDocument();
    }
    if (status === "gateway_confirmed") expect(screen.getByText("Gateway 정리 확인 · 서버 반영 중")).toBeVisible();
  });

  it("polls an accepted operation and only completed invalidates selected-site queries and publishes success", async () => {
    const { client } = mount(); const invalidation = vi.spyOn(client, "invalidateQueries");
    await submit();
    currentView = { ...view, status: "completed", completedAt: instant };
    await screen.findByText("조명 등록을 삭제했습니다.", {}, { timeout: 4000 });
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ["dashboard", siteId] });
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ["floor-map", siteId] });
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ["floor-editor", siteId] });
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ["registration-sessions", "active", siteId] });
    expect(invalidation).not.toHaveBeenCalledWith({ queryKey: ["dashboard"] });
    expect(posts).toHaveLength(1);
  });

  it.each([siteId, "66666666-6666-4666-8666-666666666666"])("invalidates default dashboards only when their actual site matches the completed operation (%s)", async cachedSiteId => {
    const { client } = mount();
    const defaultKeys = [["dashboard", "default"], ["dashboard", "default", "with-fixtures"]];
    for (const key of defaultKeys) client.setQueryData(key, { site: { id: cachedSiteId } });
    const otherSiteKey = ["dashboard", "77777777-7777-4777-8777-777777777777"];
    client.setQueryData(otherSiteKey, { site: { id: otherSiteKey[1] } });
    await submit();
    const check = await screen.findByRole("button", { name: "상태 확인" });
    await waitFor(() => expect(check).toBeEnabled());
    currentView = { ...view, status: "completed", completedAt: instant };
    fireEvent.click(check);
    await screen.findByText("조명 등록을 삭제했습니다.");
    for (const key of defaultKeys) expect(client.getQueryState(key)?.isInvalidated).toBe(cachedSiteId === siteId);
    expect(client.getQueryState(otherSiteKey)?.isInvalidated).toBe(false);
  });

  it("allows a new explicit preview only after a confirmed rejected operation is acknowledged", async () => {
    currentView = { ...view, status: "rejected", errorCode: "GATEWAY_BUSY" };
    mount(); await submit();
    expect(await screen.findByText("등록 삭제가 거절되어 기존 등록이 유지됩니다. 차단 사유를 해결한 뒤 새로 확인하세요.")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "거절 결과 확인" }));
    expect(sessionStorage.length).toBe(0);
    const dialog = await open();
    expect(within(dialog).getByRole("button", { name: "등록 삭제" })).toBeEnabled();
    expect(posts).toHaveLength(1);
  });

  it("ignores a late GET completion after switching sites", async () => {
    const { client, switchScope } = mount(); const invalidation = vi.spyOn(client, "invalidateQueries");
    await submit();
    let finish!: (response: Response) => void;
    getBarrier = new Promise(resolve => { finish = resolve; });
    try {
      fireEvent.click(await screen.findByRole("button", { name: "상태 확인" }));
      await waitFor(() => expect(requests.some(request => request.path.endsWith(operationId))).toBe(true));
      switchScope("66666666-6666-4666-8666-666666666666");
    } finally { await act(async () => finish(Response.json({ ...view, status: "completed", completedAt: instant }))); }
    expect(invalidation).not.toHaveBeenCalled();
    expect(screen.queryByText("조명 등록을 삭제했습니다.")).not.toBeInTheDocument();
  });

  it("blocks mutations if an existing recovery record is corrupted instead of discarding it", async () => {
    const first = mount(); await submit(); first.unmount();
    const key = sessionStorage.key(0)!;
    sessionStorage.setItem(key, "{broken");
    mount(); fireEvent.click(screen.getByRole("button", { name: "삭제 열기" }));
    await screen.findAllByText(/복구 정보를 읽지 못해/);
    expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: "등록 삭제" })).toBeDisabled();
    expect(posts).toHaveLength(1);
    expect(sessionStorage.getItem(key)).toBe("{broken");
  });

  it("recovers after unmount using stored operation identity without another POST", async () => {
    const first = mount(); await submit(); first.unmount();
    currentView = { ...view, status: "completed", completedAt: instant };
    mount(); await screen.findByText("조명 등록을 삭제했습니다.");
    expect(posts).toHaveLength(1);
    expect(requests.some(request => request.path.endsWith(`/registration-removals/${operationId}`))).toBe(true);
  });

  it("recovers any UUID shape accepted by the shared contract, including UUIDv7 operation IDs", async () => {
    const first = mount(); await submit(); first.unmount();
    const uuid7 = "44444444-4444-7444-8444-444444444444";
    const key = sessionStorage.key(0)!;
    sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(sessionStorage.getItem(key)!), operationId: uuid7 }));
    currentView = { ...view, operationId: uuid7 };
    mount();
    await screen.findByText("삭제 접수 · Gateway 확인 대기");
    expect(requests.some(request => request.path.endsWith(uuid7))).toBe(true);
    expect(posts).toHaveLength(1);
  });

  it("retains lost POST identity, looks up by request and only explicitly retries the identical body", async () => {
    failPost = true; currentView = null;
    const first = mount(); await submit();
    await screen.findByText("요청 결과 미확인");
    const body = posts[0]; first.unmount();
    currentPreview = { ...preview, expectedUpdatedAt: "2026-10-16T00:05:00.000Z" };
    mount();
    await waitFor(() => expect(requests.some(request => request.path.endsWith(`/by-request/${body.clientRequestId}`))).toBe(true));
    expect(posts).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: "같은 요청 다시 보내기" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual(body);
  });

  it("recovers a lost POST response through by-request without replaying the mutation", async () => {
    failPost = true; mount(); await submit();
    await screen.findByText("삭제 접수 · Gateway 확인 대기");
    expect(posts).toHaveLength(1);
  });

  it("retains unknown state on failed status GET and never automatically sends a new request", async () => {
    failGet = true; mount(); await submit();
    fireEvent.click(await screen.findByRole("button", { name: "상태 확인" }));
    await screen.findByText("요청 결과 미확인");
    expect(posts).toHaveLength(1);
    expect(screen.queryByText("조명 등록을 삭제했습니다.")).not.toBeInTheDocument();
  });

  it("blocks destructive POST if session storage cannot preserve recovery identity", async () => {
    mount(); const dialog = await open();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    fireEvent.click(within(dialog).getByRole("button", { name: "등록 삭제" }));
    expect(await within(dialog).findByText(/복구 정보를 저장하지 못해/)).toBeVisible();
    expect(posts).toEqual([]);
  });

  it("also blocks an explicit same-request retry if recovery storage becomes unavailable", async () => {
    failPost = true; currentView = null; mount(); await submit();
    await screen.findByText("요청 결과 미확인");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    fireEvent.click(screen.getByRole("button", { name: "같은 요청 다시 보내기" }));
    expect(await screen.findByText(/복구 정보를 저장하지 못해/)).toBeVisible();
    expect(posts).toHaveLength(1);
  });

  it.each(["site", "principal"])("discards late completion after a %s switch", async kind => {
    let finish!: (response: Response) => void;
    postBarrier = new Promise(resolve => { finish = resolve; });
    const { client, switchScope } = mount(); const invalidation = vi.spyOn(client, "invalidateQueries");
    try {
      await submit();
      switchScope(kind === "site" ? "66666666-6666-4666-8666-666666666666" : siteId, kind === "principal" ? "other:org" : "admin:org");
    } finally { await act(async () => finish(Response.json({ ...view, status: "completed", completedAt: instant }, { status: 202 }))); }
    expect(invalidation).not.toHaveBeenCalled();
    expect(screen.queryByText("조명 등록을 삭제했습니다.")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "등록 삭제 작업" })).not.toBeInTheDocument();
  });
});
