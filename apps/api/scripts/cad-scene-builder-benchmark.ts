import { buildCadScene } from "../src/floor-import/cad-scene-builder";
import type { CadDetectedRegion } from "../src/floor-import/cad-region-detector";
import type { CadPoint, NormalizedCadDocument, NormalizedCadEntity } from "../src/floor-import/cad-types";

if (process.env.CAD_SCENE_BENCHMARK_CHILD !== "1") {
  throw new Error("CAD scene benchmark must run through the isolated test process");
}

const primitiveCount = 300_000;
const point = (x: number, y: number): CadPoint => ({ x, y, z: 0 });
const entities: NormalizedCadEntity[] = Array.from({ length: primitiveCount }, (_, index) => {
  const x = index % 600;
  const y = Math.floor(index / 600);
  return {
    type: "line" as const,
    sourceEntityId: `benchmark-${index}`,
    layer: "BENCHMARK",
    start: point(x, y),
    end: point(x + 0.25, y + 0.25)
  };
});
const document: NormalizedCadDocument = {
  version: 1,
  bounds: { minX: 0, minY: 0, maxX: 600, maxY: 500 },
  blocks: [],
  entities
};
const region: CadDetectedRegion = {
  regionId: "benchmark-region",
  bounds: { minX: 0, minY: 0, maxX: 600, maxY: 500 },
  primitiveCount,
  textCount: 0,
  lightCandidateCount: 0,
  area: 300_000
};
const beforeBuildMaxRss = process.resourceUsage().maxRSS * 1_024;
const startedAt = performance.now();
const scene = buildCadScene(document, region, {
  sceneId: "00000000-0000-4000-8000-000000000101",
  maxExpandedEntities: primitiveCount,
  maxSelectedPrimitives: primitiveCount
});
const durationMs = performance.now() - startedAt;
const maxRss = process.resourceUsage().maxRSS * 1_024;
const measurement = {
  primitiveCount: scene.manifest.primitiveCount,
  durationMs: Math.round(durationMs),
  beforeBuildMaxRssMb: Math.round(beforeBuildMaxRss / 1_024 / 1_024),
  maxRssMb: Math.round(maxRss / 1_024 / 1_024),
  buildMaxRssDeltaMb: Math.round(Math.max(0, maxRss - beforeBuildMaxRss) / 1_024 / 1_024)
};

console.info(`CAD_BENCHMARK_RESULT=${JSON.stringify(measurement)}`);
