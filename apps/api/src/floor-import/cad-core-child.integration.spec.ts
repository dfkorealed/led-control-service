import { cadSceneManifestSchema } from "@led-control/shared";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChildProcessCadCoreExecutor } from "./cad-core-executor";
import { computeCandidateRegionDigests } from "./cad-candidate-region-digest";
import { cadRegionPreviewPersistenceIdentity, cadScenePersistenceIdentity } from "./cad-scene-persistence";

const enabled = process.env.CAD_CORE_CHILD_INTEGRATION === "1";

(enabled ? describe : describe.skip)("CAD core child native artifacts", () => {
  jest.setTimeout(60_000);

  it("writes verified region previews and selected scene artifacts for a sample DXF", async () => {
    const firstDirectory = await mkdtemp(join(tmpdir(), "cad-core-regions-"));
    const selectedDirectory = await mkdtemp(join(tmpdir(), "cad-core-scene-"));
    const dxfPath = resolve(process.cwd(), "../../scripts/fixtures/cad-import/valid-mixed-layout.dxf");
    const executor = new ChildProcessCadCoreExecutor({
      entryPath: resolve(process.cwd(), "dist/src/floor-import/cad-core-child.js")
    });
    const jobId = randomUUID();

    try {
      const detected = await executor.execute({
        dxfPath,
        renderedPath: join(firstDirectory, "rendered.svg"),
        artifactDirectory: firstDirectory,
        jobId,
        selectedRegionId: null,
        profileId: "generic-lighting-v1"
      });
      expect(detected.regions.length).toBeGreaterThan(0);
      expect(detected.regionPreviews).toHaveLength(detected.regions.length);
      for (const preview of detected.regionPreviews ?? []) {
        const identity = cadRegionPreviewPersistenceIdentity(jobId, preview.regionId);
        const payload = await readFile(join(firstDirectory, preview.filename));
        expect(preview).toMatchObject({
          assetId: identity.assetId,
          filename: `${identity.assetId}.svg`,
          sizeBytes: payload.byteLength,
          sha256: sha256(payload)
        });
      }

      const selectedRegion = detected.regions[0];
      const selected = await executor.execute({
        dxfPath,
        renderedPath: join(selectedDirectory, "rendered.svg"),
        artifactDirectory: selectedDirectory,
        jobId,
        selectedRegionId: selectedRegion.regionId,
        expectedCandidateRegionDigests: computeCandidateRegionDigests(
          detected.regions.map(region => region.regionId),
          detected.candidateRegionAssignments ?? [],
          detected.candidates.map(candidate => candidate.sourceEntityId)
        ),
        profileId: "generic-lighting-v1"
      });
      expect(selected.regionPreviews).toEqual([]);
      expect(selected.scene).not.toBeNull();
      const identity = cadScenePersistenceIdentity(jobId, selectedRegion.regionId);
      expect(selected.scene).toMatchObject({
        sceneId: identity.sceneId,
        manifestAssetId: identity.manifestAssetId,
        manifestFilename: `${identity.manifestAssetId}.json`,
        width: expect.any(Number),
        height: expect.any(Number)
      });
      const manifestPayload = await readFile(join(selectedDirectory, selected.scene!.manifestFilename));
      expect(manifestPayload.byteLength).toBe(selected.scene!.manifestByteSize);
      expect(sha256(manifestPayload)).toBe(selected.scene!.manifestSha256);
      const manifest = cadSceneManifestSchema.parse({
        ...JSON.parse(manifestPayload.toString("utf8")),
        byteSize: selected.scene!.manifestByteSize,
        sha256: selected.scene!.manifestSha256
      });
      expect(manifest).toMatchObject({
        sceneId: identity.sceneId,
        regionId: selectedRegion.regionId,
        manifestAssetId: identity.manifestAssetId,
        sourceBounds: selectedRegion.bounds
      });
      expect(selected.scene).toMatchObject({ width: manifest.width, height: manifest.height });
      expect(selected.scene).toMatchObject({
        sourceBounds: manifest.sourceBounds,
        transform: manifest.transform
      });
      expect(selected.selectedCandidates).toHaveLength(selectedRegion.lightCandidateCount);
      const detectedCandidates = new Map(selected.candidates.map(candidate => [candidate.sourceEntityId, candidate]));
      expect(selected.candidateRegionAssignments).toHaveLength(selected.candidates.length);
      const selectedAssignmentIds = new Set((selected.candidateRegionAssignments ?? [])
        .filter(assignment => assignment.regionId === selectedRegion.regionId)
        .map(assignment => assignment.sourceEntityId));
      expect(selectedAssignmentIds.size).toBe(selectedRegion.lightCandidateCount);
      for (const candidate of selected.selectedCandidates ?? []) {
        const detectedCandidate = detectedCandidates.get(candidate.sourceEntityId);
        expect(detectedCandidate).toBeDefined();
        expect(selectedAssignmentIds.has(candidate.sourceEntityId)).toBe(true);
        const source = detectedCandidate!.sourcePosition!;
        expect(source.x).toBeGreaterThanOrEqual(selectedRegion.bounds.minX);
        expect(source.x).toBeLessThanOrEqual(selectedRegion.bounds.maxX);
        expect(source.y).toBeGreaterThanOrEqual(selectedRegion.bounds.minY);
        expect(source.y).toBeLessThanOrEqual(selectedRegion.bounds.maxY);
        expect(candidate.x).toBeCloseTo(source.x * manifest.transform.scaleX + manifest.transform.translateX, 9);
        expect(candidate.y).toBeCloseTo(source.y * manifest.transform.scaleY + manifest.transform.translateY, 9);
        expect(candidate.rotation).toBe(detectedCandidate!.rotation);
        expect(candidate.x).toBeGreaterThanOrEqual(0);
        expect(candidate.x).toBeLessThanOrEqual(manifest.width);
        expect(candidate.y).toBeGreaterThanOrEqual(0);
        expect(candidate.y).toBeLessThanOrEqual(manifest.height);
      }
      expect(manifest.tiles.length).toBeGreaterThan(0);
      for (const tile of manifest.tiles) {
        const payload = await readFile(join(selectedDirectory, `${tile.assetId}.bin`));
        expect(tile.assetId).toBe(identity.tileAssetId(tile));
        expect(payload.byteLength).toBe(tile.byteSize);
        expect(sha256(payload)).toBe(tile.sha256);
      }
    } finally {
      await rm(firstDirectory, { recursive: true, force: true });
      await rm(selectedDirectory, { recursive: true, force: true });
    }
  });
});

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
