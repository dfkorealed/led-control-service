import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VehicleEventSourceStatus } from "./VehicleEventSourceStatus";
import type { DashboardFixture } from "../../../api/queries";
import { getSensorModeOperation, requestSensorMode, type SensorModeOperationResponse } from "../../../api/automation";

vi.mock("../../../api/automation", async original => ({ ...await original<typeof import("../../../api/automation")>(), requestSensorMode: vi.fn(), getSensorModeOperation: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const fixture = { id: "fixture", name: "A", vehicleEventSource: { sensorProtocol: "bio-usb-pulse", readiness: "off", capabilityEvidence: "off", sourceEligible: false,
  targetEligible: true, blockReasons: ["product_gate_off", "mode_unverified"], modeVerification: { commandId: null, status: "unverified", modeVerified: false, verifiedAt: null } } } as DashboardFixture;

function operation(overrides: Partial<SensorModeOperationResponse> = {}): SensorModeOperationResponse {
  return { commandId: "command", siteId: "site", fixtureId: "fixture", operation: "query", requeryOfCommandId: null,
    status: "pending", requestedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-01T00:00:30.000Z",
    supersededAt: null, observedMode: null, modeVerified: false, verifiedAt: null, ...overrides };
}

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
  expect(await screen.findByText(/GET 확인 시점:/)).toBeVisible();
  expect(requestSensorMode).toHaveBeenCalledTimes(1);
});

it("offers a read-only requery and labels verified GET as historical evidence without readiness promotion", async () => {
  vi.mocked(requestSensorMode).mockResolvedValue(operation({ commandId: "query-command" }));
  vi.mocked(getSensorModeOperation).mockResolvedValue(operation({ commandId: "query-command", modeVerified: true, status: "verified", observedMode: "sensor", verifiedAt: "2026-10-01T00:00:00.000Z" }));
  render(<VehicleEventSourceStatus siteId="site" fixture={fixture} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "상태 재조회" }));
  expect(await screen.findByText(/GET 확인 시점:/)).toHaveTextContent(/과거 확인 기록/);
  expect(screen.getByText(/제품 지원 OFF/)).toBeVisible();
  expect(requestSensorMode).toHaveBeenCalledWith(expect.objectContaining({ operation: "query" }));
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
