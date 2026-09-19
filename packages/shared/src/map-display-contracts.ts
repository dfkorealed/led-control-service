import { z } from "zod";
import { cadSceneManifestFieldsSchema, cadSceneManifestSchema, refineCadSceneManifestTiles } from "./cad-scene-contracts.js";

/** Native/checkpoint display coordinates are already logical map coordinates;
 * unlike imported CAD, they must not be normalized or Y-flipped a second time.
 * This applies equally to empty maps and nonempty derived display generations. */
export const nativeMapDisplayManifestSchema = cadSceneManifestFieldsSchema.extend({
  padding: z.literal(0),
  gridSize: z.number().int().min(5).max(200)
}).superRefine((manifest, context) => {
  const expectedBounds = { minX: 0, minY: 0, maxX: manifest.width, maxY: manifest.height };
  if (Object.entries(expectedBounds).some(([key, value]) => manifest.sourceBounds[key as keyof typeof expectedBounds] !== value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceBounds"], message: "sourceBounds must equal the logical map extent" });
  }
  const expectedTransform = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 };
  if (Object.entries(expectedTransform).some(([key, value]) => manifest.transform[key as keyof typeof expectedTransform] !== value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["transform"], message: "native map display transform must be identity" });
  }
  refineCadSceneManifestTiles(manifest, context);
});

/** Import displays retain the unchanged CAD source contract. The native branch
 * is explicit and does not relax or replace cadSceneManifestSchema. */
export const mapDisplayManifestSchema = z.union([nativeMapDisplayManifestSchema, cadSceneManifestSchema]);
export type MapDisplayManifest = z.infer<typeof mapDisplayManifestSchema>;
