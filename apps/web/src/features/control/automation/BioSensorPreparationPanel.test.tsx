import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as automation from "../../../api/automation";
import type { DashboardFixture } from "../../../api/queries";
import { BioSensorPreparationPanel } from "./BioSensorPreparationPanel";

vi.mock("../../../api/automation", async original => ({ ...await original<typeof import("../../../api/automation")>(),
  requestBioSensorPreparation: vi.fn(), getBioSensorPreparation: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
const fixture: DashboardFixture = { id: "arbitrary-light-17", name: "서쪽 출입등", gateway: { id: "gateway-37", name: "연결 장치", connectionStatus: "online" },
  x: 10, y: 10, ratedWatt: 40, brightness: 70, status: "online", health: null, rssi: null, hopCount: null, commandSuccessRate: null, lastSeenAt: null, controllable: true, controlBlockReason: null,
  bioSensorPreparation: { preparationCandidate: true, status: "unverified", commandId: null, profileKey: null, observedAt: null,
    blockedReasons: ["profile_unverified", "mode_unverified"] },
  vehicleEventSource: { sensorProtocol: "bio-usb-pulse", sourceEligible: false, targetEligible: true, capabilityEvidence: "off", readiness: "off", blockReasons: [],
    modeVerification: { commandId: null, modeVerified: false, verifiedAt: null, status: "unverified" } }
};
function receipt(patch = {}) { return { commandId: "operation-9", siteId: "site-23", fixtureId: fixture.id, operation: "query" as const,
  catalogRevision: 2, status: "pending" as const, requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
  supersededAt: null, observedAt: null, profileKey: null, modeVerified: false, linkVerified: false, blockReason: "preparation_pending", errorCode: null, ...patch }; }
function panel(props = {}) { return <BioSensorPreparationPanel siteId="site-23" fixture={fixture} disabled={false} canPrepare onRefreshSource={vi.fn().mockResolvedValue(undefined)} {...props} />; }

it("shows both profile and mode reasons and protects commission operations for a control viewer", () => {
  render(panel({ canPrepare: false }));
  expect(screen.getByText(/호환 프로파일 확인 필요/)).toBeVisible();
  expect(screen.getByText(/센서 모드 확인 필요/)).toBeVisible();
  expect(screen.getByRole("button", { name: "센서 사용 설정" })).toBeDisabled();
  expect(screen.getByText(/현장 관리자에게/)).toBeVisible();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("does not turn accepted checkpoint ready into eligibility and refreshes server source after GET", async () => {
  vi.mocked(automation.requestBioSensorPreparation).mockResolvedValue(receipt({ status: "ready", modeVerified: true, linkVerified: true }));
  vi.mocked(automation.getBioSensorPreparation).mockResolvedValue(receipt({ status: "ready", modeVerified: true, linkVerified: true }));
  const refresh = vi.fn().mockResolvedValue(undefined); const select = vi.fn();
  render(panel({ onRefreshSource: refresh, onSelectSource: select }));
  fireEvent.click(screen.getByRole("button", { name: "센서 사용 설정" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "감지 센서로 선택" })).toBeDisabled();
  expect(screen.getByText(/준비 작업 확인.*현재 서버/)).toBeVisible();
  expect(select).not.toHaveBeenCalled();
});

it("deduplicates rapid setup clicks and retries a lost GET without another POST", async () => {
  let finish!: (value: ReturnType<typeof receipt>) => void;
  vi.mocked(automation.requestBioSensorPreparation).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  vi.mocked(automation.getBioSensorPreparation).mockRejectedValueOnce(new Error("raw secret must not display"));
  render(panel());
  const button = screen.getByRole("button", { name: "센서 사용 설정" }); fireEvent.click(button); fireEvent.click(button);
  await act(async () => finish(receipt()));
  expect(await screen.findByRole("alert")).not.toHaveTextContent("raw secret");
  vi.mocked(automation.getBioSensorPreparation).mockResolvedValue(receipt({ status: "failed" }));
  fireEvent.click(screen.getByRole("button", { name: "요청 결과 확인" }));
  await waitFor(() => expect(automation.getBioSensorPreparation).toHaveBeenCalledTimes(2));
  expect(automation.requestBioSensorPreparation).toHaveBeenCalledTimes(1);
});

it("ignores a late result after changed fixture or authoritative catalog evidence", async () => {
  let finish!: (value: ReturnType<typeof receipt>) => void;
  vi.mocked(automation.requestBioSensorPreparation).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const refresh = vi.fn(); const view = render(panel({ onRefreshSource: refresh }));
  fireEvent.click(screen.getByRole("button", { name: "준비 상태 확인" }));
  view.rerender(panel({ fixture: { ...fixture, id: "arbitrary-light-81", name: "동쪽 통로등" }, onRefreshSource: refresh }));
  await act(async () => finish(receipt({ status: "ready" })));
  expect(screen.queryByText(/준비 작업 확인.*현재 서버/)).not.toBeInTheDocument();
  expect(refresh).not.toHaveBeenCalled();
  expect(automation.getBioSensorPreparation).not.toHaveBeenCalled();
});

it("ends automatic polling and offers manual GET after finite pending reads", async () => {
  vi.useFakeTimers();
  vi.mocked(automation.requestBioSensorPreparation).mockResolvedValue(receipt());
  vi.mocked(automation.getBioSensorPreparation).mockResolvedValue(receipt());
  render(panel()); fireEvent.click(screen.getByRole("button", { name: "준비 상태 확인" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  const count = vi.mocked(automation.getBioSensorPreparation).mock.calls.length;
  expect(count).toBeGreaterThan(1); expect(count).toBeLessThanOrEqual(5);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(automation.getBioSensorPreparation).toHaveBeenCalledTimes(count);
  expect(screen.getByRole("button", { name: "요청 결과 확인" })).toBeEnabled();
});

it("only confirms the fixture after current dashboard sourceEligible becomes true", () => {
  const select = vi.fn(); const view = render(panel({ onSelectSource: select }));
  expect(screen.getByRole("button", { name: "감지 센서로 선택" })).toBeDisabled();
  view.rerender(panel({ fixture: { ...fixture, vehicleEventSource: { ...fixture.vehicleEventSource!, sourceEligible: true } }, onSelectSource: select }));
  fireEvent.click(screen.getByRole("button", { name: "감지 센서로 선택" }));
  expect(select).toHaveBeenCalledWith(fixture.id);
});

it("refreshes the dashboard after POST acceptance before a pending GET can be mistaken for current eligibility", async () => {
  vi.mocked(automation.requestBioSensorPreparation).mockResolvedValue(receipt());
  vi.mocked(automation.getBioSensorPreparation).mockReturnValue(new Promise(() => {}));
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(panel({ fixture: { ...fixture, vehicleEventSource: { ...fixture.vehicleEventSource!, sourceEligible: true } }, onRefreshSource: refresh, onSelectSource: vi.fn() }));
  fireEvent.click(screen.getByRole("button", { name: "센서 사용 설정" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "감지 센서로 선택" })).toBeDisabled();
});

it("reuses the same request identity after a lost POST response", async () => {
  vi.mocked(automation.requestBioSensorPreparation).mockRejectedValueOnce(new Error("lost response")).mockResolvedValue(receipt({ status: "failed" }));
  vi.mocked(automation.getBioSensorPreparation).mockResolvedValue(receipt({ status: "failed" }));
  render(panel()); fireEvent.click(screen.getByRole("button", { name: "센서 사용 설정" }));
  await screen.findByRole("alert"); const original = vi.mocked(automation.requestBioSensorPreparation).mock.calls[0][0];
  fireEvent.click(screen.getByRole("button", { name: "센서 사용 설정" }));
  await waitFor(() => expect(automation.requestBioSensorPreparation).toHaveBeenCalledTimes(2));
  expect(vi.mocked(automation.requestBioSensorPreparation).mock.calls[1][0]).toEqual(original);
});

it("preserves pending work across equal projection values and rejects a changed authoritative profile", async () => {
  let finish!: (value: ReturnType<typeof receipt>) => void;
  vi.mocked(automation.requestBioSensorPreparation).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = render(panel()); fireEvent.click(screen.getByRole("button", { name: "준비 상태 확인" }));
  view.rerender(panel({ fixture: structuredClone(fixture) }));
  expect(screen.getByRole("button", { name: "준비 상태 확인" })).toBeDisabled();
  view.rerender(panel({ fixture: { ...fixture, bioSensorPreparation: { ...fixture.bioSensorPreparation!, profileKey: "changed@3" } } }));
  await act(async () => finish(receipt({ status: "ready" })));
  expect(automation.getBioSensorPreparation).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "준비 상태 확인" })).toBeEnabled();
});
