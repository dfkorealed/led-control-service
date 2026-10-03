import type { DashboardFixture } from "../../api/queries";
import { Heading, SidePanel, Text } from "../../components/ui";
import { FixtureStatusBadge } from "./FixtureStatusBadge";
import type { FixtureMapPosition } from "../floor-map/fixture-map-position";
import { presentFixtureBrightness } from "./fixture-brightness-presentation";
import { presentFixtureStatus } from "./fixture-status-presentation";
import { formatMonitoringTimestamp } from "./monitoring-time";

export function FixtureDetailPanel({ fixture, position, timeZone = "Asia/Seoul" }: {
  fixture: DashboardFixture | null; position: FixtureMapPosition; timeZone?: string;
}) {
  const status = fixture ? presentFixtureStatus(fixture) : null;
  const brightness = fixture ? presentFixtureBrightness(fixture) : null;
  // The inspector drawer owns scrolling. An inner zero-range scrollport with
  // SidePanel's default containment traps native touch swipes before they reach
  // that drawer, so this consumer stays plain content instead of another owner.
  return <SidePanel className="grid min-w-0 gap-4 overflow-visible overscroll-auto border-border-default bg-surface-panel p-4 shadow-none" aria-label="선택 조명 상세" data-monitoring-detail-panel="">
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <Heading as="h3" variant="card-title" className="min-w-0 break-words">{fixture?.name ?? "조명 선택"}</Heading>
      <FixtureStatusBadge fixture={fixture} />
    </div>
    {fixture && status && brightness ? <section className="grid min-w-0 gap-3" aria-label="선택 조명 정보">
      <div className="grid gap-2 rounded-panel bg-action-primary p-4 text-content-inverse">
        <Text as="span" variant="body-sm" tone="inverse">{brightness.label}</Text>
        <Text as="strong" variant="display" tone="inverse">{brightness.value}</Text>
        {brightness.observedAt ? <Text variant="caption" tone="inverse">마지막 확인: <time dateTime={brightness.observedAt}>{formatMonitoringTimestamp(brightness.observedAt, timeZone)}</time></Text> : null}
      </div>
      <dl className="m-0 grid gap-3">
        {[["상태 안내", status.description], ["권장 조치", status.recommendedAction], ["지도 배치", position.kind === "placed" ? "배치됨" : position.kind === "unplaced" ? "미배치" : "위치 확인 전"]].map(([label, value]) =>
          <div key={label} className="grid min-w-0 gap-1 rounded-control border border-border-default p-3">
            <dt className="text-body-sm text-content-secondary">{label}</dt>
            <dd className="m-0 min-w-0 break-words text-body-sm">{value}</dd>
          </div>)}
      </dl>
    </section> : <Text tone="secondary">지도나 목록에서 조명을 선택해 주세요. 아직 조회되지 않은 조명의 정보는 확인 전으로 표시됩니다.</Text>}
  </SidePanel>;
}
