import type { FloorMapSnapshot } from "@led-control/shared";
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
    <div className="floor-map" style={{ aspectRatio: `${snapshot.width} / ${snapshot.height}` }} role="region" aria-label="층 도면">
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
    </div>
  );
}
