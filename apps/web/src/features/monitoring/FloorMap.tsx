import type { CSSProperties } from "react";
import { Dashboard } from "../../api/queries";

interface FloorMapProps {
  floor: Dashboard["floors"][number];
}

export function FloorMap({ floor }: FloorMapProps) {
  const width = floor.floorPlan?.width ?? 1200;
  const height = floor.floorPlan?.height ?? 800;

  return (
    <div className="floor-map" style={{ aspectRatio: `${width} / ${height}` }} aria-label={`${floor.name} 조명 맵`}>
      <div className="floor-map-label">
        <span>{floor.name}</span>
        <strong>실시간 조명 배치</strong>
      </div>
      {floor.fixtures.map((fixture) => (
        <button
          key={fixture.id}
          className={`fixture-dot ${fixture.status}`}
          style={{ left: `${(fixture.x / width) * 100}%`, top: `${(fixture.y / height) * 100}%` }}
          title={`${fixture.name} ${fixture.status} ${fixture.brightness}%`}
          aria-label={`${fixture.name} ${fixture.status} ${fixture.brightness}%`}
        >
          <span className="fixture-name">{fixture.name}</span>
          <strong>{fixture.brightness}%</strong>
          <span className="fixture-bar" style={{ "--brightness": `${fixture.brightness}%` } as CSSProperties} />
        </button>
      ))}
    </div>
  );
}
