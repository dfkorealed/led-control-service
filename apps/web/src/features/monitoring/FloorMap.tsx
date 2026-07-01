import { Dashboard } from "../../api/queries";

interface FloorMapProps {
  floor: Dashboard["floors"][number];
}

export function FloorMap({ floor }: FloorMapProps) {
  const width = floor.floorPlan?.width ?? 1200;
  const height = floor.floorPlan?.height ?? 800;

  return (
    <div className="floor-map" style={{ aspectRatio: `${width} / ${height}` }} aria-label={`${floor.name} 조명 맵`}>
      {floor.fixtures.map((fixture) => (
        <button
          key={fixture.id}
          className={`fixture-dot ${fixture.status}`}
          style={{ left: `${(fixture.x / width) * 100}%`, top: `${(fixture.y / height) * 100}%` }}
          title={`${fixture.name} ${fixture.brightness}%`}
        >
          <span>{fixture.name}</span>
          <strong>{fixture.brightness}%</strong>
        </button>
      ))}
    </div>
  );
}
