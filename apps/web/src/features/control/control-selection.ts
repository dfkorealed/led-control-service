import type { DimmingTarget } from "@led-control/shared";
import type { Dashboard, DashboardFixture } from "../../api/queries";
import { fixtureGroupReadiness, floorMeshReadiness } from "./control-readiness";

export const MAX_FIXTURE_SELECTION = 1_000;

export type ControlMode = "fixtures" | "floor" | "group";

export type ControlSelection =
  | { mode: "fixtures"; fixtureIds: string[] }
  | { mode: "floor"; floorId: string }
  | { mode: "group"; groupId: string };

export interface ResolvedControlSelection {
  selection: ControlSelection;
  fixtureIds: string[];
  fixtures: DashboardFixture[];
  gatewayIds: string[];
  blockedFixtureIds: string[];
  available: boolean;
  unavailableReason: string | null;
}

export function toggleFixtureSelection(current: readonly string[], fixtureId: string) {
  const selected = new Set(current);
  if (selected.delete(fixtureId)) return { fixtureIds: [...selected].sort(), limitReached: false };
  if (selected.size >= MAX_FIXTURE_SELECTION) return { fixtureIds: [...selected], limitReached: true };
  selected.add(fixtureId);
  return { fixtureIds: [...selected].sort(), limitReached: false };
}

export function controlSelectionToDimmingTarget(selection: ControlSelection): DimmingTarget | null {
  if (selection.mode === "fixtures") {
    if (selection.fixtureIds.length === 0) return null;
    return selection.fixtureIds.length === 1
      ? { type: "fixture", fixtureId: selection.fixtureIds[0] }
      : { type: "fixtures", fixtureIds: selection.fixtureIds };
  }
  if (selection.mode === "floor") {
    return selection.floorId ? { type: "floor", floorId: selection.floorId } : null;
  }
  return selection.groupId ? { type: "group", groupId: selection.groupId } : null;
}

export function resolveControlSelection(
  dashboard: Dashboard,
  selection: ControlSelection
): ResolvedControlSelection {
  const fixtureById = new Map(
    dashboard.floors.flatMap((floor) => floor.fixtures).map((fixture) => [fixture.id, fixture])
  );

  if (selection.mode === "fixtures") {
    const fixtureIds = stableFixtureIds(selection.fixtureIds);
    return resolveFixtures(
      { mode: "fixtures", fixtureIds },
      fixtureIds,
      fixtureById
    );
  }

  if (selection.mode === "floor") {
    const floor = dashboard.floors.find((item) => item.id === selection.floorId);
    if (!floor) return unavailableSelection(selection, "선택한 층을 찾을 수 없습니다.");

    const fixtureIds = stableFixtureIds(floor.fixtures.map((fixture) => fixture.id));
    const result = resolveFixtures(selection, fixtureIds, fixtureById);
    if (!result.available) return result;

    const readiness = floorMeshReadiness(floor);
    return readiness.ready
      ? result
      : { ...result, available: false, unavailableReason: readiness.error ?? readiness.label };
  }

  const group = dashboard.groups.find((item) => item.id === selection.groupId);
  if (!group) return unavailableSelection(selection, "선택한 구역을 찾을 수 없습니다.");

  const fixtureIds = stableFixtureIds(group.fixtureIds);
  const result = resolveFixtures(selection, fixtureIds, fixtureById);
  if (!result.available) return result;

  const readiness = fixtureGroupReadiness(group);
  return readiness.ready
    ? result
    : { ...result, available: false, unavailableReason: readiness.error ?? readiness.label };
}

function resolveFixtures(
  selection: ControlSelection,
  fixtureIds: string[],
  fixtureById: ReadonlyMap<string, DashboardFixture>
): ResolvedControlSelection {
  const fixtures = fixtureIds.flatMap((fixtureId) => {
    const fixture = fixtureById.get(fixtureId);
    return fixture ? [fixture] : [];
  });
  const gatewayIds = [...new Set(fixtures.flatMap((fixture) => fixture.gateway?.id ?? []))].sort();
  const blockedFixtureIds = fixtures
    .filter((fixture) => !fixture.controllable)
    .map((fixture) => fixture.id)
    .sort();
  const missingFixtureIds = fixtureIds.filter((fixtureId) => !fixtureById.has(fixtureId));

  const unavailableReason = selectionUnavailableReason({
    selection,
    fixtureIds,
    missingFixtureIds,
    fixtures,
    gatewayIds,
    blockedFixtureIds
  });

  return {
    selection,
    fixtureIds,
    fixtures,
    gatewayIds,
    blockedFixtureIds,
    available: unavailableReason === null,
    unavailableReason
  };
}

function selectionUnavailableReason(input: {
  selection: ControlSelection;
  fixtureIds: string[];
  missingFixtureIds: string[];
  fixtures: DashboardFixture[];
  gatewayIds: string[];
  blockedFixtureIds: string[];
}) {
  if (input.selection.mode === "fixtures" && input.fixtureIds.length === 0) {
    return "제어 대상을 하나 이상 선택해 주세요.";
  }
  if (input.fixtureIds.length === 0) return "선택한 대상에 조명이 없습니다.";
  if (input.selection.mode === "fixtures" && input.fixtureIds.length > MAX_FIXTURE_SELECTION) {
    return "개별 조명은 최대 1,000개까지 선택할 수 있습니다.";
  }
  if (input.missingFixtureIds.length > 0) return "선택한 조명을 찾을 수 없습니다.";
  if (input.fixtures.some((fixture) => !fixture.gateway?.id)) {
    return "선택한 조명에 연결된 게이트웨이가 없습니다.";
  }
  if (input.gatewayIds.length !== 1) {
    return "한 번의 제어 대상은 같은 게이트웨이에 연결되어야 합니다.";
  }
  if (input.blockedFixtureIds.length > 0) return "선택한 조명 중 제어할 수 없는 대상이 있습니다.";
  return null;
}

function unavailableSelection(selection: ControlSelection, unavailableReason: string): ResolvedControlSelection {
  return {
    selection,
    fixtureIds: [],
    fixtures: [],
    gatewayIds: [],
    blockedFixtureIds: [],
    available: false,
    unavailableReason
  };
}

function stableFixtureIds(fixtureIds: readonly string[]) {
  return [...new Set(fixtureIds)].sort();
}
