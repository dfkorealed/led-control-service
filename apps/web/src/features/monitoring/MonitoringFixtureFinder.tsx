import { useState } from "react";
import { Link } from "react-router-dom";
import type { DashboardFixture } from "../../api/queries";
import { LoadingIndicator, Button, SearchField, SelectBox, Text  } from "../../components/ui";
import type { FloorMapSnapshot } from "@led-control/shared";
import { resolveFixtureMapPosition } from "../floor-map/fixture-map-position";
import { matchesMonitoringFixture, matchesMonitoringFixtureSearch, type MonitoringFixtureFilter } from "./monitoring-fixture-filter";
import { FixtureStatusBadge } from "./FixtureStatusBadge";

type FixtureFilter = MonitoringFixtureFilter;

const filterOptions: Array<{ id: FixtureFilter; label: string }> = [
  { id: "all", label: "전체" },
  { id: "online", label: "정상" },
  { id: "fault", label: "점검 필요" },
  { id: "offline", label: "오프라인" },
  { id: "unplaced", label: "미배치" }
];
const emptyFilterCopy: Record<FixtureFilter, string> = {
  all: "검색 결과가 없습니다.", online: "정상 조명이 없습니다.", fault: "점검 필요 조명이 없습니다.",
  offline: "오프라인 조명이 없습니다.", unplaced: "미배치 조명이 없습니다."
};

export interface MonitoringFixtureFinderProps {
  fixtures: DashboardFixture[];
  selectedFixtureId: string | null;
  onSelectFixture: (fixtureId: string) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  userRole: "admin" | "viewer" | "operator";
  siteId: string;
  floorId: string;
  placedFixtureIds?: ReadonlySet<string>;
  snapshot?: FloorMapSnapshot;
  filter?: FixtureFilter;
  onFilterChange?: (filter: FixtureFilter) => void;
  search?: string;
  onSearchChange?: (search: string) => void;
  nextPageError?: boolean;
  expectedTotal?: number | null;
}

export function MonitoringFixtureFinder({
  fixtures, selectedFixtureId, onSelectFixture, hasNextPage, isFetchingNextPage, onLoadMore,
  userRole, siteId, floorId, placedFixtureIds, snapshot, filter: controlledFilter, onFilterChange, search: controlledSearch, onSearchChange, nextPageError = false, expectedTotal
}: MonitoringFixtureFinderProps) {
  const [localSearch, setLocalSearch] = useState("");
  const search = controlledSearch ?? localSearch;
  const [localFilter, setLocalFilter] = useState<FixtureFilter>("all");
  const filter = controlledFilter ?? localFilter;
  const normalizedSearch = search.trim().toLocaleLowerCase("ko-KR");
  const isUnplaced = (fixture: DashboardFixture) =>
    snapshot ? resolveFixtureMapPosition(snapshot, fixture).kind === "unplaced" : !placedFixtureIds?.has(fixture.id) && fixture.placementStatus === "unplaced";
  const visibleFixtures = fixtures.filter((fixture) => {
    if (!matchesMonitoringFixtureSearch(fixture, normalizedSearch)) return false;
    return matchesMonitoringFixture(fixture, filter, snapshot ? resolveFixtureMapPosition(snapshot, fixture) : isUnplaced(fixture) ? { kind: "unplaced" } : { kind: "unknown" });
  });

  return <section className="grid min-w-0 gap-3" aria-label="조명 검색 및 목록" data-monitoring-fixture-finder="">
    <SearchField label="조명 이름 또는 번호 검색" value={search} onChange={(value) => {
      setLocalSearch(value);
      onSearchChange?.(value);
    }} placeholder="조명 이름 또는 번호" className="min-w-0" />
    <SelectBox label="상태 필터" items={filterOptions} selectedKey={filter} onSelectionChange={(key) => {
        setLocalFilter(key ?? "all");
        onFilterChange?.(key ?? "all");
      }} />
    <div className="grid min-w-0 gap-2">
      <ul className="m-0 grid max-h-48 min-w-0 list-none gap-1 overflow-y-auto p-0" aria-label="조명 목록">
        {visibleFixtures.map((fixture) => <li key={fixture.id} className="min-w-0">
          <Button variant="ghost" className="w-full min-w-0 justify-between text-left" aria-pressed={fixture.id === selectedFixtureId} onClick={() => {
            onSelectFixture(fixture.id);
          }}>
            <span className="min-w-0 truncate">{fixture.name}</span>
            <span className="shrink-0">{isUnplaced(fixture) ? <Text variant="caption" tone="secondary">미배치</Text> : <FixtureStatusBadge fixture={fixture} />}</span>
          </Button>
        </li>)}
      </ul>
      {visibleFixtures.length === 0 && !hasNextPage && !isFetchingNextPage && !nextPageError ? <div className="grid gap-2"><Text variant="body-sm" tone="secondary">{normalizedSearch ? "검색 결과가 없습니다." : emptyFilterCopy[filter]}</Text>{filter !== "all" ? <Button variant="secondary" onClick={() => { setLocalSearch(""); onSearchChange?.(""); setLocalFilter("all"); onFilterChange?.("all"); }}>전체 조명 보기</Button> : null}</div> : null}
      {nextPageError ? <Text variant="body-sm" tone="secondary">일부 조명만 표시 중입니다. 다음 조명 보기를 눌러 다시 시도해 주세요.</Text> : null}
      {!hasNextPage && !isFetchingNextPage && !nextPageError && expectedTotal != null && fixtures.length !== expectedTotal
        ? <Text variant="body-sm" tone="secondary">목록과 집계의 확인 시점이 다릅니다. 새로고침해 주세요.</Text> : null}
      {hasNextPage ? isFetchingNextPage
        ? <LoadingIndicator>다음 조명을 불러오는 중입니다.</LoadingIndicator>
        : <Button variant="secondary" onClick={onLoadMore}>다음 조명 보기</Button>
        : null}
      {filter === "unplaced" && userRole === "admin" && visibleFixtures.length > 0 ? (
        <Link className="text-body-sm font-bold text-action-primary underline" to={`/settings/floor-plans/${encodeURIComponent(floorId)}/edit?siteId=${encodeURIComponent(siteId)}`}>
          설정에서 조명 배치
        </Link>
      ) : null}
    </div>
  </section>;
}
