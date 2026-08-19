import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlView } from "./ControlView";

const queryMocks = vi.hoisted(() => ({
  useControlDashboard: vi.fn(),
  useCommandStatus: vi.fn()
}));

vi.mock("../../api/queries", () => ({ useControlDashboard: queryMocks.useControlDashboard }));
vi.mock("../../api/commands", () => ({ useCommandStatus: queryMocks.useCommandStatus }));

describe("ControlView Health 상태", () => {
  afterEach(() => cleanup());

  it("shows a fixture Health fault in the control list", () => {
    queryMocks.useCommandStatus.mockReturnValue({ data: undefined, error: null });
    queryMocks.useControlDashboard.mockReturnValue({
      data: {
        site: { id: "site-1", name: "테스트 현장" },
        summary: { totalFixtures: 1, onlineFixtures: 0, faultFixtures: 1, averageBrightness: 70 },
        floors: [{
          id: "floor-1",
          name: "B1",
          level: -1,
          floorPlan: null,
          fixtures: [{
            id: "fixture-1",
            name: "B1-L001",
            x: 100,
            y: 100,
            ratedWatt: 40,
            brightness: 70,
            status: "fault",
            statusReason: "mesh_publication",
            health: { faultCodes: [4], observedAt: "2026-08-19T01:00:01.000Z" },
            rssi: null,
            hopCount: null,
            commandSuccessRate: null,
            lastSeenAt: "2026-08-19T01:00:01.000Z",
            gateway: { id: "gateway-1", name: "GW-1", connectionStatus: "online" },
            controllable: false,
            controlBlockReason: "fixture_fault"
          }]
        }],
        groups: [],
        gateways: []
      }
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <ControlView siteId="site-1" userRole="admin" />
      </QueryClientProvider>
    );

    expect(screen.getByText("Health 장애")).toBeInTheDocument();
  });
});
