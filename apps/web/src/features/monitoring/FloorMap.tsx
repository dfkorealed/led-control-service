import type { FloorMapSnapshot } from "@led-control/shared";
import { CircleCheck, CircleX, Clock3, TriangleAlert } from "lucide-react";
import { Dashboard } from "../../api/queries";
import { FloorScene } from "../floor-map/FloorScene";

interface FloorMapProps {
  floor: Dashboard["floors"][number];
  snapshot: FloorMapSnapshot;
  selectedFixtureId: string | null;
  onSelectFixture: (fixtureId: string) => void;
}

export function FloorMap({ floor, snapshot, selectedFixtureId, onSelectFixture }: FloorMapProps) {
  return (
    <div className="floor-map monitoring-map-card" style={{ aspectRatio: `${snapshot.width} / ${snapshot.height}` }} role="region" aria-label="층 도면">
      <FloorScene
        snapshot={snapshot}
        fixtures={floor.fixtures}
        interactive={false}
        floorName={floor.name}
        selectedFixtureId={selectedFixtureId}
        onSelectFixture={onSelectFixture}
      />
      <div className="floor-map-label">
        <span>{floor.name}</span>
        <strong>실시간 조명 배치</strong>
      </div>
      <ul className="floor-map-legend" aria-label="조명 상태 범례">
        <li><CircleCheck size={14} aria-hidden="true" /><span>정상</span></li>
        <li><TriangleAlert size={14} aria-hidden="true" /><span>장애</span></li>
        <li><CircleX size={14} aria-hidden="true" /><span>오프라인</span></li>
        <li><Clock3 size={14} aria-hidden="true" /><span>상태 확인 대기</span></li>
      </ul>
    </div>
  );
}
