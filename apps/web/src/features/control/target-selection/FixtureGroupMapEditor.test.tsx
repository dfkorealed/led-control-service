import type { FloorMapSnapshot } from "@led-control/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dashboard } from "../../../api/queries";
import { FixtureGroupMapEditor, type FixtureGroupEditorValue } from "./FixtureGroupMapEditor";

const floorMapQuery = vi.hoisted(() => vi.fn());

vi.mock("../../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/queries")>()),
  useFloorMapSnapshot: floorMapQuery
}));

const ids = {
  site: "site-a",
  floorB2: "floor-b2",
  floorB1: "floor-b1",
  gatewayB2: "gateway-b2",
  gatewayB1: "gateway-b1",
  fixtureA: "fixture-b2-a",
  fixtureB: "fixture-b2-b",
  fixtureC: "fixture-b2-c",
  fixtureUnplaced: "fixture-b2-unplaced",
  fixtureB1: "fixture-b1-a"
};

const snapshot: FloorMapSnapshot = {
  floorId: ids.floorB2,
  revision: 1,
  width: 600,
  height: 400,
  floorPlan: null,
  objects: []
};

describe("FixtureGroupMapEditor", () => {
  beforeEach(() => {
    floorMapQuery.mockReturnValue({ data: snapshot, error: null, isLoading: false, isFetching: false });
  });

  afterEach(cleanup);

  it("locks the floor and gateway after the first fixture", () => {
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: /B2-L001/ }));

    expect(screen.getByText("B2 · GW-B2 경계")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "표시 층" }));
    fireEvent.click(screen.getByRole("option", { name: "B1" }));
    expect(screen.getByRole("button", { name: /B1-L001.*선택 불가/ })).toBeDisabled();
  });

  it("keeps an existing boundary after every fixture is removed", () => {
    renderEditor({ value: value({ fixtureIds: [ids.fixtureA], floorId: ids.floorB2, gatewayId: ids.gatewayB2 }) });

    fireEvent.click(screen.getByRole("button", { name: /B2-L001/ }));

    expect(screen.getByText("B2 · GW-B2 경계")).toBeInTheDocument();
  });

  it("keeps unplaced fixtures selectable from the list fallback", () => {
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "조명 목록 열기" }));
    expect(screen.getByText("미배치")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "B2-L004 선택" }));

    expect(screen.getByText("B2 · GW-B2 경계")).toBeInTheDocument();
  });

  it("shows pending additions and removals for an existing membership", () => {
    renderEditor({ value: value({ groupId: "group-b2", fixtureIds: [ids.fixtureA, ids.fixtureB], floorId: ids.floorB2, gatewayId: ids.gatewayB2 }) });

    fireEvent.click(screen.getByRole("button", { name: /B2-L002/ }));
    fireEvent.click(screen.getByRole("button", { name: /B2-L003/ }));

    expect(screen.getByText("제거 예정: B2-L002")).toBeInTheDocument();
    expect(screen.getByText("추가 예정: B2-L003")).toBeInTheDocument();
  });

  it("locks map and list actions while saving", () => {
    renderEditor({ disabled: true });

    expect(screen.getByRole("button", { name: /B2-L001/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "조명 목록 열기" })).toBeDisabled();
  });
});

function renderEditor(overrides: Partial<ComponentProps<typeof FixtureGroupMapEditor>> = {}) {
  return render(<EditorHarness {...overrides} />);
}

function EditorHarness(overrides: Partial<ComponentProps<typeof FixtureGroupMapEditor>>) {
  const [current, setCurrent] = useState(overrides.value ?? value());
  return <FixtureGroupMapEditor siteId={ids.site} dashboard={dashboard} disabled={false} {...overrides} value={current} onChange={(next) => {
    setCurrent(next);
    overrides.onChange?.(next);
  }} />;
}

function value(overrides: Partial<FixtureGroupEditorValue> = {}): FixtureGroupEditorValue {
  return {
    groupId: null,
    name: "",
    floorId: "",
    gatewayId: "",
    fixtureIds: [],
    ...overrides
  };
}

const dashboard: Dashboard = {
  generatedAt: "2026-09-17T00:00:00.000Z",
  monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
  site: { id: ids.site, name: "테스트 현장", customerName: "고객사", installationStatus: "installed", address: null, tariffKwhRate: null, timeZone: "Asia/Seoul" },
  summary: { totalFixtures: 5, onlineFixtures: 5, faultFixtures: 0, averageBrightness: 70 },
  floors: [
    { id: ids.floorB2, name: "B2", level: -2, floorPlan: null, meshControlGroups: [{ gatewayId: ids.gatewayB2, status: "ready", version: 1, error: null }], fixtures: [
      fixture(ids.fixtureA, "B2-L001", ids.gatewayB2, "GW-B2", 100, 100),
      fixture(ids.fixtureB, "B2-L002", ids.gatewayB2, "GW-B2", 200, 100),
      fixture(ids.fixtureC, "B2-L003", ids.gatewayB2, "GW-B2", 300, 100),
      fixture(ids.fixtureUnplaced, "B2-L004", ids.gatewayB2, "GW-B2", 0, 0, "unplaced")
    ] },
    { id: ids.floorB1, name: "B1", level: -1, floorPlan: null, meshControlGroups: [{ gatewayId: ids.gatewayB1, status: "ready", version: 1, error: null }], fixtures: [fixture(ids.fixtureB1, "B1-L001", ids.gatewayB1, "GW-B1", 100, 100)] }
  ],
  groups: [],
  gateways: [
    { id: ids.gatewayB2, name: "GW-B2", serialNumber: "B2", firmwareVersion: "1", lastHeartbeatAt: null, connectionStatus: "online" },
    { id: ids.gatewayB1, name: "GW-B1", serialNumber: "B1", firmwareVersion: "1", lastHeartbeatAt: null, connectionStatus: "online" }
  ]
};

function fixture(id: string, name: string, gatewayId: string, gatewayName: string, x: number, y: number, placementStatus: "placed" | "unplaced" = "placed"): Dashboard["floors"][number]["fixtures"][number] {
  return { id, name, x, y, placementStatus, ratedWatt: 40, brightness: 70, status: "online", health: { faultCodes: [], observedAt: "2026-09-17T00:00:00.000Z" }, rssi: -55, hopCount: 1, commandSuccessRate: 1, lastSeenAt: "2026-09-17T00:00:00.000Z", gateway: { id: gatewayId, name: gatewayName, connectionStatus: "online" }, controllable: true, controlBlockReason: null };
}
