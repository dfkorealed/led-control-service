import { describe, expect, it } from "vitest";
import type { DimmingTarget } from "@led-control/shared";
import { mockDashboard } from "../../test/fixtures";
import {
  MAX_FIXTURE_SELECTION,
  controlSelectionToDimmingTarget,
  resolveControlSelection,
  toggleFixtureSelection,
  type ControlSelection
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

  it("reports a non-controllable fixture as blocked", () => {
    const fixture = mockDashboard.floors[0].fixtures[5];

    expect(resolveControlSelection(mockDashboard, {
      mode: "fixtures",
      fixtureIds: [fixture.id]
    })).toMatchObject({
      blockedFixtureIds: [fixture.id],
      available: false,
      unavailableReason: "선택한 조명 중 제어할 수 없는 대상이 있습니다."
    });
  });

  it("reports a fixture without a gateway assignment as unavailable", () => {
    const dashboard = {
      ...mockDashboard,
      floors: mockDashboard.floors.map((floor, floorIndex) => floorIndex === 0 ? {
        ...floor,
        fixtures: floor.fixtures.map((fixture, fixtureIndex) => fixtureIndex === 0
          ? { ...fixture, gateway: null }
          : fixture)
      } : floor)
    };

    expect(resolveControlSelection(dashboard, {
      mode: "fixtures",
      fixtureIds: [fixtureA]
    })).toMatchObject({
      gatewayIds: [],
      available: false,
      unavailableReason: "선택한 조명에 연결된 게이트웨이가 없습니다."
    });
  });

  it("reports a floor Mesh-readiness failure", () => {
    const dashboard = withControllableFixtures({
      ...mockDashboard,
      floors: mockDashboard.floors.map((floor, floorIndex) => floorIndex === 0 ? {
        ...floor,
        meshControlGroups: [{ ...floor.meshControlGroups[0], status: "configuring" }]
      } : floor)
    });

    expect(resolveControlSelection(dashboard, {
      mode: "floor",
      floorId: dashboard.floors[0].id
    })).toMatchObject({
      available: false,
      unavailableReason: "Gateway 0/1 준비 · Mesh 설정 중"
    });
  });

  it("reports a group Mesh-readiness failure", () => {
    const dashboard = {
      ...mockDashboard,
      groups: mockDashboard.groups.map((group, groupIndex) => groupIndex === 0 ? {
        ...group,
        meshControlGroup: { status: "failed" as const, version: 2, error: "subscription rejected" }
      } : group)
    };

    expect(resolveControlSelection(dashboard, {
      mode: "group",
      groupId: dashboard.groups[0].id
    })).toMatchObject({
      available: false,
      unavailableReason: "subscription rejected"
    });
  });

  it.each([
    { selection: { mode: "fixtures", fixtureIds: [] }, target: null },
    { selection: { mode: "fixtures", fixtureIds: [fixtureA] }, target: { type: "fixture", fixtureId: fixtureA } },
    { selection: { mode: "fixtures", fixtureIds: [fixtureA, fixtureB] }, target: { type: "fixtures", fixtureIds: [fixtureA, fixtureB] } },
    { selection: { mode: "floor", floorId: mockDashboard.floors[0].id }, target: { type: "floor", floorId: mockDashboard.floors[0].id } },
    { selection: { mode: "group", groupId: mockDashboard.groups[0].id }, target: { type: "group", groupId: mockDashboard.groups[0].id } }
  ] satisfies Array<{ selection: ControlSelection; target: DimmingTarget | null }>)("converts $selection to the unchanged dimming target", ({ selection, target }) => {
    expect(controlSelectionToDimmingTarget(selection)).toEqual(target);
  });

  it("does not add fixture 1001", () => {
    const current = Array.from({ length: MAX_FIXTURE_SELECTION }, (_, index) => `fixture-${index}`);

    expect(toggleFixtureSelection(current, "fixture-overflow")).toEqual({
      fixtureIds: current,
      limitReached: true
    });
  });
});

function withControllableFixtures(dashboard: typeof mockDashboard) {
  return {
    ...dashboard,
    floors: dashboard.floors.map((floor) => ({
      ...floor,
      fixtures: floor.fixtures.map((fixture) => ({
        ...fixture,
        controllable: true,
        controlBlockReason: null
      }))
    }))
  };
}
