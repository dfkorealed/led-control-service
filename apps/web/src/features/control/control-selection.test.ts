import { describe, expect, it } from "vitest";
import { mockDashboard } from "../../test/fixtures";
import {
  MAX_FIXTURE_SELECTION,
  resolveControlSelection,
  toggleFixtureSelection
} from "./control-selection";

const fixtureA = mockDashboard.floors[0].fixtures[0].id;
const fixtureB = mockDashboard.floors[1].fixtures[0].id;
const gatewayA = mockDashboard.floors[0].fixtures[0].gateway!.id;
const gatewayB = "00000000-0000-4000-8000-000000000099";

const multiGatewayDashboard = {
  ...mockDashboard,
  floors: mockDashboard.floors.map((floor, floorIndex) => floorIndex === 1
    ? {
      ...floor,
      meshControlGroups: [{ ...floor.meshControlGroups[0], gatewayId: gatewayB }],
      fixtures: floor.fixtures.map((fixture) => ({
        ...fixture,
        gateway: fixture.gateway ? { ...fixture.gateway, id: gatewayB, name: "Gateway B1" } : null
      }))
    }
    : floor),
  gateways: [
    ...mockDashboard.gateways,
    {
      id: gatewayB,
      name: "Gateway B1",
      serialNumber: "GW-DEMO-002",
      firmwareVersion: "mock-1.0.0",
      lastHeartbeatAt: "2026-09-12T00:00:00.000Z",
      connectionStatus: "online" as const
    }
  ]
};

describe("control selection", () => {
  it("resolves fixture ids in stable order and rejects a second gateway", () => {
    const result = resolveControlSelection(multiGatewayDashboard, {
      mode: "fixtures",
      fixtureIds: [fixtureB, fixtureA, fixtureB]
    });

    expect(result.fixtureIds).toEqual([fixtureA, fixtureB]);
    expect(result.gatewayIds).toEqual([gatewayA, gatewayB]);
    expect(result.available).toBe(false);
    expect(result.unavailableReason).toBe("한 번의 제어 대상은 같은 게이트웨이에 연결되어야 합니다.");
  });

  it("keeps a missing fixture id visible as an unavailable selection", () => {
    const result = resolveControlSelection(mockDashboard, {
      mode: "fixtures",
      fixtureIds: [fixtureA, "missing-fixture"]
    });

    expect(result.fixtureIds).toEqual([fixtureA, "missing-fixture"]);
    expect(result.fixtures.map((fixture) => fixture.id)).toEqual([fixtureA]);
    expect(result.available).toBe(false);
    expect(result.unavailableReason).toBe("선택한 조명을 찾을 수 없습니다.");
  });

  it("does not add fixture 1001", () => {
    const current = Array.from({ length: MAX_FIXTURE_SELECTION }, (_, index) => `fixture-${index}`);

    expect(toggleFixtureSelection(current, "fixture-overflow")).toEqual({
      fixtureIds: current,
      limitReached: true
    });
  });
});
