import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VehicleEventSourceStatus } from "./VehicleEventSourceStatus";
import type { DashboardFixture } from "../../../api/queries";
import { getSensorModeOperation, requestSensorMode, type SensorModeOperationResponse, type SensorModeVerification } from "../../../api/automation";

vi.mock("../../../api/automation", async original => ({ ...await original<typeof import("../../../api/automation")>(), requestSensorMode: vi.fn(), getSensorModeOperation: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const fixture = { id: "fixture", name: "A", vehicleEventSource: { sensorProtocol: "bio-usb-pulse", readiness: "off", capabilityEvidence: "off", sourceEligible: false,
  targetEligible: true, blockReasons: ["product_gate_off", "mode_unverified"], modeVerification: { commandId: null, status: "unverified", modeVerified: false, verifiedAt: null } } } as DashboardFixture;

function operation(overrides: Partial<SensorModeOperationResponse> = {}): SensorModeOperationResponse {
  return { commandId: "command", siteId: "site", fixtureId: "fixture", operation: "query", requeryOfCommandId: null,
    status: "pending", requestedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-01T00:00:30.000Z",
    supersededAt: null, observedMode: null, modeVerified: false, verifiedAt: null, ...overrides };
}

function withEvidence(modeVerification: SensorModeVerification): DashboardFixture {
  return { ...fixture, vehicleEventSource: { ...fixture.vehicleEventSource!, modeVerification } };
}

it.each([
  operation({ commandId: "new-command", status: "pending" }),
  { commandId: null, status: "unverified", modeVerified: false, verifiedAt: null },
  operation({ commandId: "command", status: "verified", modeVerified: false, verifiedAt: null })
])("replaces an older GET result with authoritative new command or invalidated identity evidence: %j", async latest => {
  const verified = operation({ modeVerified: true, status: "verified", verifiedAt: "2026-10-01T00:00:10.000Z" });
  vi.mocked(requestSensorMode).mockResolvedValue(operation());
  vi.mocked(getSensorModeOperation).mockResolvedValue(verified);
  const view = render(<VehicleEventSourceStatus siteId="site" fixture={fixture} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "상태 재조회" }));
  await waitFor(() => expect(getSensorModeOperation).toHaveBeenCalledOnce());
  view.rerender(<VehicleEventSourceStatus siteId="site" fixture={withEvidence(verified)} disabled={false} />);
  expect(await screen.findByText(/GET 확인 시점:/)).toBeVisible();
  view.rerender(<VehicleEventSourceStatus siteId="site" fixture={withEvidence(latest)} disabled={false} />);
  expect(screen.queryByText(/GET 확인 시점:/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "상태 재조회" }));
  await waitFor(() => expect(requestSensorMode).toHaveBeenCalledTimes(2));
  const request = vi.mocked(requestSensorMode).mock.calls[1][0];
  expect(request.requeryOfCommandId).toBe(latest.commandId ?? undefined);
});

it("preserves a legitimate pending local command while the dashboard repeats older evidence", async () => {
  let resolveGet!: (result: SensorModeOperationResponse) => void;
  vi.mocked(requestSensorMode).mockResolvedValue(operation());
  vi.mocked(getSensorModeOperation).mockReturnValueOnce(new Promise(resolve => { resolveGet = resolve; }));
  const view = render(<VehicleEventSourceStatus siteId="site" fixture={fixture} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "상태 재조회" }));
  await waitFor(() => expect(getSensorModeOperation).toHaveBeenCalledOnce());
  view.rerender(<VehicleEventSourceStatus siteId="site" fixture={withEvidence({ ...fixture.vehicleEventSource!.modeVerification })} disabled={false} />);
  expect(screen.getByRole("button", { name: "상태 재조회" })).toBeDisabled();
  await act(async () => resolveGet(operation()));
  expect(screen.getByRole("button", { name: "요청 결과 확인" })).toBeEnabled();
});

it("ignores a late verified GET after a new authoritative operation arrives", async () => {
  let resolveGet!: (result: SensorModeOperationResponse) => void;
  vi.mocked(requestSensorMode).mockResolvedValue(operation());
  vi.mocked(getSensorModeOperation).mockReturnValueOnce(new Promise(resolve => { resolveGet = resolve; }));
  const view = render(<VehicleEventSourceStatus siteId="site" fixture={fixture} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "상태 재조회" }));
  await waitFor(() => expect(getSensorModeOperation).toHaveBeenCalledOnce());
  view.rerender(<VehicleEventSourceStatus siteId="site" fixture={withEvidence(operation({ commandId: "new-command" }))} disabled={false} />);
  await act(async () => resolveGet(operation({ modeVerified: true, status: "verified", verifiedAt: "2026-10-01T00:00:10.000Z" })));
  expect(screen.queryByText(/GET 확인 시점:/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "요청 결과 확인" }));
  expect(getSensorModeOperation).toHaveBeenLastCalledWith("new-command");
});

it("never treats POST acceptance or a pending GET as confirmed sensor mode", async () => {
  vi.mocked(requestSensorMode).mockResolvedValue(operation({ modeVerified: true, status: "verified", observedMode: "sensor", verifiedAt: "2026-10-01T00:00:00.000Z" }));
  vi.mocked(getSensorModeOperation).mockResolvedValue(operation());
  render(<VehicleEventSourceStatus siteId="site" fixture={fixture} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "센서 모드 설정" }));
  await waitFor(() => expect(getSensorModeOperation).toHaveBeenCalledWith("command"));
  expect(screen.getByText(/확인 대기/)).toBeVisible();
  expect(screen.queryByText(/GET 확인 시점:/)).not.toBeInTheDocument();
  expect(screen.getByText(/제품 지원 OFF/)).toBeVisible();
  expect(requestSensorMode).toHaveBeenCalledWith(expect.objectContaining({ operation: "ensure_sensor", fixtureId: "fixture", siteId: "site" }));
  vi.mocked(getSensorModeOperation).mockResolvedValue(operation({ modeVerified: true, status: "verified", observedMode: "sensor", verifiedAt: "2026-10-01T00:00:00.000Z" }));
  fireEvent.click(screen.getByRole("button", { name: "요청 결과 확인" }));
  expect(await screen.findByText(/최신 서버 상태 확인 중/)).toBeVisible();
  expect(screen.queryByText(/GET 확인 시점:/)).not.toBeInTheDocument();
  expect(requestSensorMode).toHaveBeenCalledTimes(1);
});

it("offers a read-only requery and labels verified GET as historical evidence without readiness promotion", async () => {
  vi.mocked(requestSensorMode).mockResolvedValue(operation({ commandId: "query-command" }));
  vi.mocked(getSensorModeOperation).mockResolvedValue(operation({ commandId: "query-command", modeVerified: true, status: "verified", observedMode: "sensor", verifiedAt: "2026-10-01T00:00:00.000Z" }));
  const onRefreshSource = vi.fn().mockResolvedValue(undefined);
  const view = render(<VehicleEventSourceStatus siteId="site" fixture={fixture} disabled={false} onRefreshSource={onRefreshSource} />);
  fireEvent.click(screen.getByRole("button", { name: "상태 재조회" }));
  await waitFor(() => expect(onRefreshSource).toHaveBeenCalledOnce());
  expect(screen.queryByText(/GET 확인 시점:/)).not.toBeInTheDocument();
  view.rerender(<VehicleEventSourceStatus siteId="site" fixture={withEvidence(operation({ commandId: "query-command", modeVerified: true, status: "verified", verifiedAt: "2026-10-01T00:00:00.000Z" }))} disabled={false} onRefreshSource={onRefreshSource} />);
  expect(await screen.findByText(/GET 확인 시점:/)).toHaveTextContent(/과거 확인 기록/);
  expect(screen.getByText(/제품 지원 OFF/)).toBeVisible();
  expect(requestSensorMode).toHaveBeenCalledWith(expect.objectContaining({ operation: "query" }));
});

it("keeps old verification hidden and offers server retry when dashboard refresh fails", async () => {
  const old = operation({ commandId: "old", modeVerified: true, status: "verified", verifiedAt: "2026-09-30T23:00:00.000Z" });
  vi.mocked(requestSensorMode).mockResolvedValue(operation());
  vi.mocked(getSensorModeOperation).mockResolvedValue(operation({ modeVerified: true, status: "verified", verifiedAt: "2026-10-01T00:00:10.000Z" }));
  const onRefreshSource = vi.fn().mockRejectedValueOnce(new Error("server unavailable")).mockResolvedValue(undefined);
  render(<VehicleEventSourceStatus siteId="site" fixture={withEvidence(old)} disabled={false} onRefreshSource={onRefreshSource} />);
  fireEvent.click(screen.getByRole("button", { name: "상태 재조회" }));
  await screen.findByRole("alert");
  expect(screen.queryByText(/GET 확인 시점:/)).not.toBeInTheDocument();
  expect(screen.getByText(/최신 서버 상태 확인 중/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "준비 상태 다시 조회" }));
  await waitFor(() => expect(onRefreshSource).toHaveBeenCalledTimes(2));
  expect(requestSensorMode).toHaveBeenCalledTimes(1);
});

it("retains the accepted operation for safe GET retry after a lost result response", async () => {
  vi.mocked(requestSensorMode).mockResolvedValue(operation({ commandId: "accepted-command" }));
  vi.mocked(getSensorModeOperation).mockRejectedValueOnce(new Error("network unavailable"));
  render(<VehicleEventSourceStatus siteId="site" fixture={fixture} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "센서 모드 설정" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/확인하지 못했습니다/);
  vi.mocked(getSensorModeOperation).mockResolvedValue(operation({ commandId: "accepted-command" }));
  fireEvent.click(screen.getByRole("button", { name: "요청 결과 확인" }));
  await waitFor(() => expect(getSensorModeOperation).toHaveBeenCalledTimes(2));
  expect(requestSensorMode).toHaveBeenCalledTimes(1);
});
