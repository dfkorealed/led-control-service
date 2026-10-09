import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { VehicleEventSourceStatus } from "./VehicleEventSourceStatus";
import type { DashboardFixture } from "../../../api/queries";
afterEach(cleanup);
it("renders common preparation for a confirmed legacy candidate without promoting its stored BlueZ capability", () => {
  const fixture = { id: "legacy", name: "출입구", bioSensorPreparation: { preparationCandidate: true, status: "unverified", commandId: null, profileKey: null,
    observedAt: null, blockedReasons: ["profile_unverified"] }, vehicleEventSource: { sensorProtocol: "bluez-stateful", sourceEligible: false } } as DashboardFixture;
  render(<VehicleEventSourceStatus siteId="site" fixture={fixture} disabled={false} canPrepare />);
  expect(screen.getByRole("region", { name: "출입구 센서 준비" })).toBeVisible();
  expect(screen.getByRole("button", { name: "센서 사용 설정" })).toBeEnabled();
  expect(screen.getByText(/호환 확인 필요/)).toBeVisible();
});
it("protects legacy stored BIO mode evidence from becoming ready or viewer setup permission", () => {
  const fixture = { id: "legacy", name: "출입구", vehicleEventSource: { sensorProtocol: "bio-usb-pulse", sourceEligible: false, blockReasons: ["mode_unverified"],
    modeVerification: { modeVerified: true, verifiedAt: "2026-10-01T00:00:00.000Z" } } } as DashboardFixture;
  render(<VehicleEventSourceStatus siteId="site" fixture={fixture} disabled={false} />);
  expect(screen.queryByText(/사용 가능$/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "센서 사용 설정" })).toBeDisabled();
  expect(screen.getByText(/현장 관리자에게/)).toBeVisible();
});
