import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testPolicy } from "./monitoring-test-fixtures";
import { MonitoringPolicyDialog } from "./MonitoringPolicyDialog";
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  fetchMock = vi.fn().mockResolvedValue(Response.json(testPolicy));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });
function mount() {
  function Host() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>판정 기준</button>{open && <MonitoringPolicyDialog siteId="site-1" onClose={() => setOpen(false)} />}</>;
  }
  render(<QueryClientProvider client={client}><Host /></QueryClientProvider>);
  screen.getByRole("button", { name: "판정 기준" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "판정 기준" }));
}

describe("monitoring policy dialog", () => {
  it.each([["29", "180"], ["901", "180"], ["90", "59"], ["90", "3601"], ["30.5", "180"], ["", "180"]])("rejects out-of-range or non-integer inputs %s/%s without PATCH", async (gateway, fixture) => {
    mount();
    const gatewayInput = await screen.findByRole("spinbutton", { name: "게이트웨이 오프라인 기준 (초)" });
    fireEvent.change(gatewayInput, { target: { value: gateway } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "조명 수신 지연 기준 (초)" }), { target: { value: fixture } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("정수");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
  });

  it("initializes current values, submits boundaries and revision, prevents closing while pending, then returns focus", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((_path, init) => init?.method === "PATCH" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(Response.json(testPolicy)));
    mount();
    const gateway = await screen.findByRole("spinbutton", { name: "게이트웨이 오프라인 기준 (초)" });
    expect(gateway).toHaveValue(90);
    expect(gateway).toHaveFocus();
    fireEvent.change(gateway, { target: { value: "30" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "조명 수신 지연 기준 (초)" }), { target: { value: "3600" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "닫기" })).toBeDisabled());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.mouseDown(screen.getByTestId("modal-backdrop"));
    expect(screen.getByRole("dialog")).toBeVisible();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(patch?.[1].body)).toEqual({ gatewayOfflineAfterSeconds: 30, fixtureStaleAfterSeconds: 3600, expectedUpdatedAt: "2026-09-12T01:00:00.000Z" });
    await act(async () => finish(Response.json({ ...testPolicy, gatewayOfflineAfterSeconds: 30, fixtureStaleAfterSeconds: 3600 })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "판정 기준" })).toHaveFocus();
  });

  it("keeps edits after conflict, fetches latest revision and requires explicit review before saving again", async () => {
    let policyReads = 0;
    fetchMock.mockImplementation((_path, init) => Promise.resolve(init?.method === "PATCH"
      ? Response.json({ code: "MONITORING_POLICY_CONFLICT" }, { status: 409 })
      : Response.json(++policyReads === 1 ? testPolicy : { ...testPolicy, gatewayOfflineAfterSeconds: 120, updatedAt: "2026-09-12T02:00:00.000Z" })));
    mount();
    fireEvent.change(await screen.findByRole("spinbutton", { name: "게이트웨이 오프라인 기준 (초)" }), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("재검토");
    await waitFor(() => expect(policyReads).toBeGreaterThan(1));
    expect(screen.getByRole("spinbutton", { name: "게이트웨이 오프라인 기준 (초)" })).toHaveValue(45);
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    expect(screen.getByText(/현재 서버 기준:.*120/)).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "최신 기준을 확인했습니다" }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(2));
    const patch = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")[1];
    expect(JSON.parse(patch?.[1].body).expectedUpdatedAt).toBe("2026-09-12T02:00:00.000Z");
  });

  it("keeps the form and entered values when a cached policy refresh fails", async () => {
    mount();
    const gateway = await screen.findByRole("spinbutton", { name: "게이트웨이 오프라인 기준 (초)" });
    fireEvent.change(gateway, { target: { value: "45" } });
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({}, { status: 503 })));
    await act(async () => { await client.invalidateQueries({ queryKey: ["monitoring-policy", "site-1"] }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("저장된 판정 기준");
    expect(gateway).toHaveValue(45);
    expect(screen.getByRole("button", { name: "판정 기준 다시 시도" })).toBeEnabled();
  });

  it("requires a fresh review if the policy changes again after the operator checked it", async () => {
    let reads = 0;
    fetchMock.mockImplementation((_path, init) => Promise.resolve(init?.method === "PATCH"
      ? Response.json({ code: "MONITORING_POLICY_CONFLICT" }, { status: 409 })
      : Response.json(++reads === 1 ? testPolicy : { ...testPolicy, updatedAt: "2026-09-12T02:00:00.000Z" })));
    mount();
    await screen.findByRole("spinbutton", { name: "게이트웨이 오프라인 기준 (초)" });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("checkbox", { name: "최신 기준을 확인했습니다" }));
    expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
    act(() => { client.setQueryData(["monitoring-policy", "site-1"], { ...testPolicy, updatedAt: "2026-09-12T03:00:00.000Z" }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "저장" })).toBeDisabled());
    expect(screen.getByRole("checkbox", { name: "최신 기준을 확인했습니다" })).not.toBeChecked();
  });
});
