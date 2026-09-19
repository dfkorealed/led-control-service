import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FloorMapSnapshot } from "@led-control/shared";
import "../../styles.css";
import { FloorMapViewport } from "./FloorMapViewport";
import { FloorScene } from "./FloorScene";

const snapshot: FloorMapSnapshot = {
  floorId: "00000000-0000-4000-8000-000000000003", revision: 1,
  width: 16384, height: 16384,
  floorPlan: {
    sourceType: "cad", imageUrl: "", originalFileUrl: null, renderedImageUrl: null,
    width: 16384, height: 16384, gridSize: 80
  },
  cadScene: {
    id: "11111111-1111-4111-8111-111111111111", version: 1,
    sourceImportJobId: "22222222-2222-4222-8222-222222222222",
    width: 16384, height: 16384, tileSize: 512, primitiveCount: 10, tileCount: 4,
    manifestAssetId: "33333333-3333-4333-8333-333333333333",
    manifestContentPath: "/smoke/manifest",
    tileContentPathTemplate: "/smoke/tiles/{lod}/{tileX}/{tileY}/{part}",
    statePath: "/smoke/state"
  },
  objects: [{
    id: "manual-object", type: "rectangle", x: 8300, y: 7900, width: 300, height: 200,
    rotation: 0, points: null, text: null, strokeColor: "#ff00ff", fillColor: "#ff00ff",
    strokeWidth: 0, fontSize: null, zIndex: 1, locked: false, visible: true
  }]
};

function Smoke() {
  const [loaded, setLoaded] = useState(false);
  const [cad, setCad] = useState(true);
  const [presses, setPresses] = useState(0);
  const [sceneVersion, setSceneVersion] = useState(1);
  const current = useMemo(() => cad ? {
    ...snapshot, cadScene: { ...snapshot.cadScene!, version: sceneVersion }
  } : {
    ...snapshot, floorId: "legacy-floor", floorPlan: null, cadScene: null
  }, [cad, sceneVersion]);
  return <main style={{ width: "100%", maxWidth: 900, height: "90vh", padding: 8 }}>
    <div style={{ height: 40 }}>
      <button onClick={() => setLoaded(true)}>Load CAD</button>
      <button onClick={() => { setCad(value => !value); setLoaded(false); }}>Switch floor</button>
      <button onClick={() => setSceneVersion(value => value + 1)}>Reload scene</button>
      <output aria-label="Fixture presses">{presses}</output>
    </div>
    <div style={{ height: "calc(100% - 40px)" }}>
      <FloorMapViewport snapshot={current} ariaLabel="합성 지도">
        {(!cad || loaded) && <FloorScene
          snapshot={current}
          fixtures={[{ id: "fixture-smoke", name: "B1-L001", x: 8200, y: 8500, brightness: 80, status: "online" }]}
          interactive={false}
          onFixturePress={() => setPresses(value => value + 1)}
        />}
      </FloorMapViewport>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Smoke />);
