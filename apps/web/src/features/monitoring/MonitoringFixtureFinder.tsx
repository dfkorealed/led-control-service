import { useId, useState } from "react";
import { Link } from "react-router-dom";
import type { DashboardFixture } from "../../api/queries";
import { Button, SearchField, SelectBox, Text } from "../../components/ui";
import { presentFixtureStatus } from "./fixture-status-presentation";

type FixtureFilter = "all" | "fault" | "offline" | "unplaced";

const filterOptions: Array<{ id: FixtureFilter; label: string }> = [
  { id: "all", label: "전체" },
  { id: "fault", label: "점검 필요" },
  { id: "offline", label: "오프라인" },
  { id: "unplaced", label: "미배치" }
];

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
}

export function MonitoringFixtureFinder({
  fixtures, selectedFixtureId, onSelectFixture, hasNextPage, isFetchingNextPage, onLoadMore,
  userRole, siteId, floorId, placedFixtureIds
}: MonitoringFixtureFinderProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FixtureFilter>("all");
  const [isOpen, setIsOpen] = useState(false);
  const listId = useId();
  const normalizedSearch = search.trim().toLocaleLowerCase("ko-KR");
  const isUnplaced = (fixture: DashboardFixture) =>
    !placedFixtureIds?.has(fixture.id) && fixture.placementStatus === "unplaced";
  const visibleFixtures = fixtures.filter((fixture) => {
    if (normalizedSearch && !fixture.name.toLocaleLowerCase("ko-KR").includes(normalizedSearch)) return false;
    if (filter === "fault") return presentFixtureStatus(fixture).state === "fault";
    if (filter === "offline") return fixture.status === "offline";
    if (filter === "unplaced") return isUnplaced(fixture);
    return true;
  });

  return <section className="grid min-w-0 gap-2 rounded-panel border border-border-default bg-surface-panel p-3" aria-label="조명 검색 및 목록" data-monitoring-fixture-finder="">
    <SearchField label="조명 이름 또는 번호 검색" value={search} onChange={(value) => {
      setSearch(value);
      setIsOpen(true);
    }} placeholder="조명 이름 또는 번호" className="min-w-0" />
    <Button variant="ghost" aria-controls={listId} aria-expanded={isOpen} onClick={() => setIsOpen((current) => !current)}>
      {isOpen ? "조명 목록 닫기" : "조명 목록 보기"}
    </Button>
    {isOpen ? <div id={listId} className="grid min-w-0 gap-2">
      <SelectBox label="상태 필터" items={filterOptions} selectedKey={filter} onSelectionChange={(key) => setFilter(key ?? "all")} />
      <ul className="m-0 grid max-h-48 min-w-0 list-none gap-1 overflow-y-auto p-0" aria-label="조명 목록">
        {visibleFixtures.map((fixture) => <li key={fixture.id} className="min-w-0">
          <Button variant="ghost" className="w-full min-w-0 justify-between text-left" aria-pressed={fixture.id === selectedFixtureId} onClick={() => {
            onSelectFixture(fixture.id);
            setIsOpen(false);
          }}>
            <span className="min-w-0 truncate">{fixture.name}</span>
            <span className="shrink-0 text-label">{isUnplaced(fixture) ? "미배치" : presentFixtureStatus(fixture).label}</span>
          </Button>
        </li>)}
      </ul>
      {visibleFixtures.length === 0 && !hasNextPage ? <Text variant="body-sm" tone="secondary">검색 결과가 없습니다.</Text> : null}
      {hasNextPage ? isFetchingNextPage
        ? <Text variant="body-sm" tone="secondary">다음 조명을 불러오는 중입니다.</Text>
        : <Button variant="secondary" onClick={onLoadMore}>다음 조명 보기</Button>
        : null}
      {filter === "unplaced" && userRole === "admin" && visibleFixtures.length > 0 ? (
        <Link className="text-body-sm font-bold text-action-primary underline" to={`/settings/floor-plans/${encodeURIComponent(floorId)}/edit?siteId=${encodeURIComponent(siteId)}`}>
          설정에서 조명 배치
        </Link>
      ) : null}
    </div> : null}
  </section>;
}
