import type { CSSProperties } from "react";
import { Dashboard } from "../../api/queries";

const fixtureStatusLabels = {
  online: "정상",
  offline: "오프라인",
  fault: "장애"
} as const;

interface FloorMapProps {
  floor: Dashboard["floors"][number];
  selectedFixtureId: string | null;
  onSelectFixture: (fixtureId: string) => void;
}

export function FloorMap({ floor, selectedFixtureId, onSelectFixture }: FloorMapProps) {
  const width = floor.floorPlan?.width ?? 1200;
  const height = floor.floorPlan?.height ?? 800;

  return (
    <div className="floor-map" style={{ aspectRatio: `${width} / ${height}` }} role="region" aria-label="층 도면">
      {floor.floorPlan ? (
        <img className="floor-map-image" src={floor.floorPlan.imageUrl} alt={`${floor.name} 도면`} />
      ) : null}
      <div className="floor-map-label">
        <span>{floor.name}</span>
        <strong>실시간 조명 배치</strong>
      </div>
      {floor.fixtures.map((fixture) => {
        const isWaitingForInitialState = fixture.statusReason === "provisioning_waiting_state";
        const statusLabel = isWaitingForInitialState
          ? "상태 확인 대기"
          : fixtureStatusLabels[fixture.status];
        const markerStyle = {
          "--fixture-left": `${(fixture.x / width) * 100}%`,
          "--fixture-top": `${(fixture.y / height) * 100}%`,
          "--brightness": `${fixture.brightness}%`
        } as CSSProperties;

        return (
          <button
            key={fixture.id}
            className={`fixture-dot ${fixture.status}${isWaitingForInitialState ? " awaiting-state" : ""}${fixture.id === selectedFixtureId ? " active" : ""}`}
            style={markerStyle}
            title={`${fixture.name} ${statusLabel} ${fixture.brightness}%`}
            aria-label={`${fixture.name} ${statusLabel} ${fixture.brightness}%`}
            onClick={() => onSelectFixture(fixture.id)}
          >
            <span className="fixture-name">{fixture.name}</span>
            <strong>{fixture.brightness}%</strong>
            <span className="fixture-bar" />
          </button>
        );
      })}
    </div>
  );
}
