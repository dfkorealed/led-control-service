import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FixtureDetailPanel } from "./FixtureDetailPanel";
import type { DashboardFixture } from "../../api/queries";
afterEach(cleanup);
const fixture: DashboardFixture = { id: "a", name: "입구", x: 100, y: 200, brightness: 42, ratedWatt: 40, status: "offline", statusReason: "fixture_stale", health: { faultCodes: [4], observedAt: "2026-09-29T01:00:00.000Z" }, rssi: -60, hopCount: 2, commandSuccessRate: .99, lastSeenAt: "2026-09-29T01:00:00.000Z", gateway: null, controllable: false, controlBlockReason: "fixture_offline" };
it("shows historical brightness, user guidance and placement but no technical information", () => {
  render(<FixtureDetailPanel fixture={fixture} position={{ kind: "unplaced" }} />);
  const detail = screen.getByRole("complementary", { name: "선택 조명 상세" });
  expect(detail).toHaveTextContent("최근 확인 밝기");
  expect(detail).toHaveTextContent("42%");
  expect(detail).toHaveTextContent("미배치");
  expect(detail).not.toHaveTextContent(/RSSI|Hop|Health|정격 전력|지도 좌표|명령 성공률|0x04/);
});
it("does not invent brightness for unobserved fixtures", () => {
  render(<FixtureDetailPanel fixture={null} position={{ kind: "unknown" }} />);
  expect(screen.getByRole("complementary")).not.toHaveTextContent("0%");
});
