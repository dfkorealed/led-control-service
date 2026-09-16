import type { FloorMapSnapshot } from "@led-control/shared";
import { CircleCheck, CircleX, Clock3, Hand, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Dashboard } from "../../api/queries";
import { Text } from "../../components/ui";
import { FloorScene } from "../floor-map/FloorScene";
import { FloorMapViewport } from "../floor-map/FloorMapViewport";
import { presentFixtureStatus } from "./fixture-status-presentation";

interface FloorMapProps {
  floor: Dashboard["floors"][number];
  snapshot: FloorMapSnapshot;
  selectedFixtureId: string | null;
  onSelectFixture: (fixtureId: string) => void;
}

export function FloorMap({ floor, snapshot, selectedFixtureId, onSelectFixture }: FloorMapProps) {
  const [zoom, setZoom] = useState(1);
  const sceneFixtures = floor.fixtures.map((fixture) => ({
    ...fixture,
    statusPresentation: presentFixtureStatus(fixture)
  }));

  return (
    <div className="relative h-[clamp(26.25rem,58vh,45rem)] w-full min-w-0 overflow-hidden rounded-panel border border-border-default bg-surface-inset tablet:h-full tablet:min-h-0" role="region" aria-label="층 도면" data-monitoring-map-shell="" data-zoom={zoom}>
      <FloorMapViewport
        snapshot={snapshot}
        ariaLabel="상하좌우로 이동하고 확대 축소할 수 있는 지도"
        onZoomChange={setZoom}
        viewportTestId="monitoring-map-viewport"
      >
        <FloorScene
          snapshot={snapshot}
          fixtures={sceneFixtures}
          interactive={false}
          floorName={floor.name}
          selectedFixtureId={selectedFixtureId}
          onSelectFixture={onSelectFixture}
        />
      </FloorMapViewport>
      <ul className="pointer-events-none absolute bottom-12 left-3 z-6 m-0 flex max-w-[calc(100%-1.5rem)] list-none flex-wrap justify-start gap-x-3 gap-y-1.5 rounded-control border border-border-default bg-surface-panel p-2 max-compact:bottom-16 max-compact:-translate-y-2.5" aria-label="조명 상태 범례">
        <li className="inline-flex items-center gap-1 whitespace-nowrap text-fixture-connected"><CircleCheck size={14} aria-hidden="true" /><Text as="span" variant="overline" className="text-fixture-connected">정상</Text></li>
        <li className="inline-flex items-center gap-1 whitespace-nowrap text-fixture-fault"><TriangleAlert size={14} aria-hidden="true" /><Text as="span" variant="overline" className="text-fixture-fault">장애</Text></li>
        <li className="inline-flex items-center gap-1 whitespace-nowrap text-fixture-offline"><CircleX size={14} aria-hidden="true" /><Text as="span" variant="overline" className="text-fixture-offline">오프라인</Text></li>
        <li className="inline-flex items-center gap-1 whitespace-nowrap text-fixture-inspection"><Clock3 size={14} aria-hidden="true" /><Text as="span" variant="overline" className="text-fixture-inspection">상태 확인 대기</Text></li>
      </ul>
      <Text as="span" variant="overline" tone="inverse" className="pointer-events-none absolute bottom-3 left-3 z-6 inline-flex items-center gap-1.5 rounded-control bg-surface-inverse px-2.5 py-1.5 max-compact:hidden" data-monitoring-map-pan-hint=""><Hand size={14} aria-hidden="true" />드래그 또는 스크롤로 이동</Text>
    </div>
  );
}
