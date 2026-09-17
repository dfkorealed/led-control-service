import { useRef, useState } from "react";
import type { Dashboard, DashboardFixture } from "../../../api/queries";
import { Card, SelectBox, Text } from "../../../components/ui";
import { SpatialTargetSelector } from "./SpatialTargetSelector";

export interface FixtureGroupEditorValue {
  groupId: string | null;
  name: string;
  floorId: string;
  gatewayId: string;
  fixtureIds: string[];
}

export interface FixtureGroupMapEditorProps {
  siteId: string;
  dashboard: Dashboard;
  value: FixtureGroupEditorValue;
  disabled: boolean;
  onChange: (value: FixtureGroupEditorValue) => void;
}

const MAX_FIXTURE_GROUP_MEMBERS = 100;

/** Keeps the web boundary aligned with the unchanged fixture-group mutation contract. */
export function fixtureGroupMembershipError(fixtureIds: readonly string[]) {
  if (new Set(fixtureIds).size !== fixtureIds.length) return "같은 조명을 중복해 선택할 수 없습니다.";
  if (fixtureIds.length === 0) return "조명을 한 개 이상 선택하세요.";
  if (fixtureIds.length > MAX_FIXTURE_GROUP_MEMBERS) return "구역에는 최대 100개 조명만 포함할 수 있습니다.";
  return null;
}

export function FixtureGroupMapEditor({ siteId, dashboard, value, disabled, onChange }: FixtureGroupMapEditorProps) {
  const original = useRef({ groupId: value.groupId, fixtureIds: [...new Set(value.fixtureIds)].sort() });
  const [membershipError, setMembershipError] = useState<string | null>(null);
  if (original.current.groupId !== value.groupId) original.current = { groupId: value.groupId, fixtureIds: [...new Set(value.fixtureIds)].sort() };

  const fixtureIndex = new Map(dashboard.floors.flatMap((floor) => floor.fixtures.map((fixture) => [fixture.id, { fixture, floorId: floor.id }] as const)));
  const floorName = dashboard.floors.find((floor) => floor.id === value.floorId)?.name ?? "층 미선택";
  const gatewayName = dashboard.gateways.find((gateway) => gateway.id === value.gatewayId)?.name
    ?? [...fixtureIndex.values()].find(({ fixture }) => fixture.gateway?.id === value.gatewayId)?.fixture.gateway?.name
    ?? "게이트웨이 미선택";
  const selectedFixtureIds = [...new Set(value.fixtureIds)].sort();
  const selected = new Set(selectedFixtureIds);
  const originalIds = new Set(original.current.fixtureIds);
  const added = selectedFixtureIds.filter((fixtureId) => !originalIds.has(fixtureId));
  const removed = original.current.fixtureIds.filter((fixtureId) => !selected.has(fixtureId));
  const boundaryLocked = selectedFixtureIds.length > 0;

  function isWithinBoundary(fixture: DashboardFixture) {
    const owner = fixtureIndex.get(fixture.id);
    if (!owner) return false;
    return (!value.floorId || owner.floorId === value.floorId)
      && (!value.gatewayId || fixture.gateway?.id === value.gatewayId);
  }

  function changeFixtures(nextFixtureIds: string[]) {
    const uniqueIds = [...new Set(nextFixtureIds)].sort();
    if (uniqueIds.length > MAX_FIXTURE_GROUP_MEMBERS) {
      // Reject atomically: the selector sorts its full union, so truncating it could evict an existing member.
      setMembershipError("구역에는 최대 100개 조명만 포함할 수 있습니다.");
      return;
    }
    setMembershipError(null);
    const firstAddedId = uniqueIds.find((fixtureId) => !selected.has(fixtureId));
    const firstAdded = firstAddedId ? fixtureIndex.get(firstAddedId) : undefined;
    // A cleared edit keeps its explicit boundary. Only a newly chosen first member establishes an empty boundary.
    onChange({
      ...value,
      fixtureIds: uniqueIds,
      floorId: value.floorId || firstAdded?.floorId || "",
      gatewayId: value.gatewayId || firstAdded?.fixture.gateway?.id || ""
    });
  }

  return <Card className="flex min-h-max flex-1 flex-col gap-3 p-4 max-compact:shrink-0" data-fixture-group-map-editor="" data-testid="fixture-group-map-editor">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Text as="strong" weight="semibold">지도에서 조명 선택</Text>
      <Text variant="caption" tone="secondary">{floorName} · {gatewayName} 경계</Text>
      <Text variant="caption" tone="secondary">{selectedFixtureIds.length} / 100개</Text>
    </div>
    <div className="grid grid-cols-2 gap-3 max-compact:grid-cols-1">
      <SelectBox label="층" items={[{ id: "", label: "층 선택" }, ...dashboard.floors.map((floor) => ({ id: floor.id, label: floor.name }))]}
        selectedKey={value.floorId} isDisabled={disabled || boundaryLocked}
        onSelectionChange={(floorId) => { setMembershipError(null); onChange({ ...value, floorId: floorId ?? "", gatewayId: "", fixtureIds: [] }); }} />
      <SelectBox label="게이트웨이" items={gatewayItems(dashboard, value.floorId)} selectedKey={value.gatewayId}
        isDisabled={disabled || boundaryLocked || !value.floorId}
        onSelectionChange={(gatewayId) => { setMembershipError(null); onChange({ ...value, gatewayId: gatewayId ?? "", fixtureIds: [] }); }} />
    </div>
    <div className="flex min-h-112 flex-1 flex-col tablet:min-h-96">
      <SpatialTargetSelector siteId={siteId} dashboard={dashboard} selection={{ mode: "fixtures", fixtureIds: selectedFixtureIds }} disabled={disabled}
        preferredFloorId={value.floorId} allowedModes={["fixtures"]} modeLabels={{ fixtures: "개별 조명" }} fixtureFilter={isWithinBoundary} fixtureFilterReason="구역과 같은 층·게이트웨이의 조명만 선택할 수 있습니다." onChange={(selection) => {
          if (selection.mode === "fixtures") changeFixtures(selection.fixtureIds);
        }} />
    </div>
    {membershipError ? <Text role="alert" tone="danger">{membershipError}</Text> : null}
    {value.groupId && (added.length > 0 || removed.length > 0) ? <div className="grid max-h-32 shrink-0 gap-1 overflow-y-auto overscroll-contain" aria-label="구역 구성 변경" role="region" tabIndex={0}>
      {added.map((fixtureId) => <Text key={`added-${fixtureId}`} variant="caption" tone="success">추가 예정: {fixtureIndex.get(fixtureId)?.fixture.name ?? fixtureId}</Text>)}
      {removed.map((fixtureId) => <Text key={`removed-${fixtureId}`} variant="caption" tone="danger">제거 예정: {fixtureIndex.get(fixtureId)?.fixture.name ?? fixtureId}</Text>)}
    </div> : null}
  </Card>;
}

function gatewayItems(dashboard: Dashboard, floorId: string) {
  const gatewayIds = new Set(dashboard.floors.find((floor) => floor.id === floorId)?.fixtures.flatMap((fixture) => fixture.gateway?.id ? [fixture.gateway.id] : []) ?? []);
  return [{ id: "", label: "게이트웨이 선택" }, ...dashboard.gateways.filter((gateway) => gatewayIds.has(gateway.id)).map((gateway) => ({ id: gateway.id, label: gateway.name }))];
}
