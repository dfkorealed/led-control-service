import { cadMapDisplayManifestSchema } from "./cad-map-preparation.service";
import { buildCadScene } from "./cad-scene-builder";
import { createCadMapElementConverter } from "./map-element-converter";

it("accepts only ordered common v2 in the prepared display envelope", () => {
  const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  const converter = createCadMapElementConverter({ importJobId: "job", regionBounds: bounds });
  const scene = buildCadScene({ version: 1, bounds, blocks: [], entities: [] },
    { regionId: "r", bounds, primitiveCount: 0, textCount: 0, lightCandidateCount: 0, area: 1e6 },
    { sceneId: "00000000-0000-4000-8000-000000000111", displayVersion: 2, onSemanticEntity: converter.convertSemanticEntity });
  const envelope = { formatVersion: 1, scene: scene.manifest, displayLayerBindings: [],
    unsupportedEntityCounts: {}, unconvertedEntityCounts: {} };
  expect(cadMapDisplayManifestSchema.parse(envelope)).toEqual(envelope);
  expect(cadMapDisplayManifestSchema.safeParse({ ...envelope, scene: { ...scene.manifest, version: 1 } }).success).toBe(false);
});
