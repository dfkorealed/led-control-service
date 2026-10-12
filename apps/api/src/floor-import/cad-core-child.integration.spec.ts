import { cadSceneManifestSchema } from "@led-control/shared";
import { fork, type ForkOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChildProcessCadCoreExecutor } from "./cad-core-executor";
import { computeCandidateRegionDigests } from "./cad-candidate-region-digest";
import { cadRegionPreviewPersistenceIdentity, cadScenePersistenceIdentity } from "./cad-scene-persistence";
import { readCanonicalElements, readCanonicalMetadata } from "./cad-canonical-spool";
import { decodeCadSceneTile } from "./cad-scene-codec";

const enabled = process.env.CAD_CORE_CHILD_INTEGRATION === "1";

describe("CAD core child source encoding boundary", () => {
  it.each([
    ["CP949", Buffer.concat([Buffer.from("LIGHT_"), Buffer.from([0xb0, 0xa1, 0x81, 0x41])])],
    ["UTF-8", Buffer.from("LIGHT_\uac00\uac02")]
  ])("preserves %s names and candidates through the production child entry", async (_encoding, nameBytes) => {
    const directory = await mkdtemp(join(tmpdir(), "cad-core-source-encoding-"));
    try {
      const groups = [
        0, "SECTION", 2, "HEADER", 9, "$ACADVER", 1, "AC1015", 9, "$DWGCODEPAGE", 3, "ANSI_949", 0, "ENDSEC",
        0, "SECTION", 2, "BLOCKS", 0, "BLOCK", 2, "@NAME@", 10, 0, 20, 0,
        0, "CIRCLE", 5, "B1", 8, "SYMBOL", 10, 0, 20, 0, 40, 1,
        0, "ENDBLK", 0, "ENDSEC", 0, "SECTION", 2, "ENTITIES",
        0, "INSERT", 5, "I1", 8, "@NAME@", 2, "@NAME@", 10, 0, 20, 0,
        0, "INSERT", 5, "I2", 8, "@NAME@", 2, "@NAME@", 10, 10, 20, 0,
        0, "ENDSEC", 0, "EOF"
      ];
      const dxfPath = join(directory, "input.dxf");
      await writeFile(dxfPath, Buffer.concat(groups.flatMap(value => [
        value === "@NAME@" ? nameBytes : Buffer.from(String(value)), Buffer.from("\n")
      ])));
      // Exercise the real IPC executor and child source without generating or
      // relying on dist. Preserve its production heap, env and wall limits.
      const executor = new ChildProcessCadCoreExecutor({
        entryPath: resolve(process.cwd(), "src/floor-import/cad-core-child.ts"),
        forkProcess: (modulePath: string | URL, argsOrOptions?: readonly string[] | ForkOptions, options?: ForkOptions) => {
          const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
          const config = Array.isArray(argsOrOptions) ? options : argsOrOptions as ForkOptions | undefined;
          return fork(modulePath, args, {
            ...config, execArgv: [...(config?.execArgv ?? []), "--import", require.resolve("tsx")]
          });
        }
      });
      const result = await executor.execute({ dxfPath, renderedPath: join(directory, "whole.svg"), profileId: "generic-lighting-v1" });
      expect(result.modelEntityCount).toBe(2);
      expect(result.blockCount).toBe(1);
      expect(result.candidates).toEqual([
        expect.objectContaining({ sourceEntityId: "I1", layerName: "LIGHT_\uac00\uac02", blockName: "LIGHT_\uac00\uac02" }),
        expect.objectContaining({ sourceEntityId: "I2", layerName: "LIGHT_\uac00\uac02", blockName: "LIGHT_\uac00\uac02" })
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

(enabled ? describe : describe.skip)("CAD core child native artifacts", () => {
  jest.setTimeout(60_000);

  it("places offset mirrored block lights at their geometry without losing selected candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-core-offset-region-"));
    const selectedDirectory = await mkdtemp(join(tmpdir(), "cad-core-offset-selected-"));
    const dxfPath = join(root, "offset.dxf");
    const groups = [
      0, "SECTION", 2, "BLOCKS", 0, "BLOCK", 2, "LIGHT", 10, 0, 20, 0,
      0, "CIRCLE", 5, "B1", 8, "SYMBOL", 10, 1000, 20, 1000, 40, 1,
      0, "ENDBLK", 0, "ENDSEC", 0, "SECTION", 2, "ENTITIES",
      0, "LINE", 5, "M1", 8, "MODEL", 10, 0, 20, 0, 11, 200, 21, 0,
      0, "INSERT", 5, "I1", 8, "LIGHTING", 2, "LIGHT", 10, 100, 20, 0, 41, -1,
      0, "INSERT", 5, "I2", 8, "LIGHTING", 2, "LIGHT", 10, 105, 20, 0, 41, -1,
      0, "ENDSEC", 0, "EOF"
    ];
    await writeFile(dxfPath, groups.join("\n") + "\n");
    const executor = new ChildProcessCadCoreExecutor({ entryPath: process.env.CAD_CORE_CHILD_ENTRY ?? resolve(process.cwd(), "dist/src/floor-import/cad-core-child.js") });
    try {
      const detected = await executor.execute({ dxfPath, renderedPath: join(root, "whole.svg"), profileId: "generic-lighting-v1" });
      expect(detected.regions).toHaveLength(2);
      expect(detected.candidates.map(candidate => candidate.sourcePosition)).toEqual([
        { x: -900, y: 1000 }, { x: -895, y: 1000 }
      ]);
      const region = detected.regions.find(item => item.lightCandidateCount === 2)!;
      const selected = await executor.execute({
        dxfPath, renderedPath: join(selectedDirectory, "whole.svg"), profileId: "generic-lighting-v1",
        artifactDirectory: selectedDirectory, jobId: randomUUID(), selectedRegionId: region.regionId,
        expectedCandidateRegionDigests: computeCandidateRegionDigests(
          detected.regions.map(item => item.regionId), detected.candidateRegionAssignments ?? [],
          detected.candidates.map(candidate => candidate.sourceEntityId)
        )
      });
      expect(selected.selectedCandidates?.map(candidate => candidate.sourceEntityId)).toEqual(["I1", "I2"]);
      expect(selected.scene?.sourceBounds).toEqual(region.bounds);
      expect(selected.candidates).toEqual(detected.candidates);
      for (const [index, candidate] of selected.selectedCandidates!.entries()) {
        const source = detected.candidates[index].sourcePosition!;
        const transform = selected.scene!.transform;
        expect(candidate.x).toBeCloseTo(source.x * transform.scaleX + transform.translateX, 9);
        expect(candidate.y).toBeCloseTo(source.y * transform.scaleY + transform.translateY, 9);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(selectedDirectory, { recursive: true, force: true });
    }
  });

  it("keeps whole-document candidate coordinates valid when selecting a narrow region", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-core-narrow-region-"));
    const selectedDirectory = await mkdtemp(join(tmpdir(), "cad-core-narrow-selected-"));
    const dxfPath = join(root, "narrow.dxf");
    const groups = [
      0, "SECTION", 2, "BLOCKS", 0, "BLOCK", 2, "LIGHT", 10, 0, 20, 0,
      0, "CIRCLE", 5, "B1", 8, "SYMBOL", 10, 0, 20, 0, 40, 1,
      0, "ENDBLK", 0, "ENDSEC", 0, "SECTION", 2, "ENTITIES",
      0, "LINE", 5, "M1", 8, "MODEL", 10, 0, 20, 0, 11, 10_000, 21, 0,
      0, "INSERT", 5, "I1", 8, "LIGHTING", 2, "LIGHT", 10, 20_000, 20, 0,
      0, "INSERT", 5, "I2", 8, "LIGHTING", 2, "LIGHT", 10, 20_000, 20, 10,
      0, "ENDSEC", 0, "EOF"
    ];
    await writeFile(dxfPath, groups.join("\n") + "\n");
    const executor = new ChildProcessCadCoreExecutor({ entryPath: process.env.CAD_CORE_CHILD_ENTRY ?? resolve(process.cwd(), "dist/src/floor-import/cad-core-child.js") });
    try {
      const detected = await executor.execute({ dxfPath, renderedPath: join(root, "whole.svg"), profileId: "generic-lighting-v1" });
      expect(detected.candidates).toHaveLength(2);
      const region = detected.regions.find(item => item.lightCandidateCount === 2)!;
      expect(region).toBeDefined();
      const selected = await executor.execute({
        dxfPath, renderedPath: join(selectedDirectory, "whole.svg"), profileId: "generic-lighting-v1",
        artifactDirectory: selectedDirectory, jobId: randomUUID(), selectedRegionId: region.regionId,
        expectedCandidateRegionDigests: computeCandidateRegionDigests(
          detected.regions.map(item => item.regionId), detected.candidateRegionAssignments ?? [],
          detected.candidates.map(candidate => candidate.sourceEntityId)
        )
      });
      expect(selected.rendered.viewport).toEqual(detected.rendered.viewport);
      expect(selected.candidates).toEqual(detected.candidates);
      expect(selected.selectedCandidates).toHaveLength(2);
      expect(selected.scene?.sourceBounds).toEqual(region.bounds);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(selectedDirectory, { recursive: true, force: true });
    }
  });

  it("writes verified region previews and selected scene artifacts for a sample DXF", async () => {
    const firstDirectory = await mkdtemp(join(tmpdir(), "cad-core-regions-"));
    const selectedDirectory = await mkdtemp(join(tmpdir(), "cad-core-scene-"));
    const dxfPath = resolve(process.cwd(), "../../scripts/fixtures/cad-import/valid-mixed-layout.dxf");
    const executor = new ChildProcessCadCoreExecutor({
      entryPath: process.env.CAD_CORE_CHILD_ENTRY ?? resolve(process.cwd(), "dist/src/floor-import/cad-core-child.js")
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
      expect(selected.canonical).toBeDefined();
      const stored = new Map();
      for await (const element of readCanonicalElements(selectedDirectory, selected.canonical!)) stored.set(element.id, element);
      const metadata = await readCanonicalMetadata(selectedDirectory, selected.canonical!);
      expect(metadata.elementCount).toBe(stored.size);
      expect(metadata.displayLayerBindings.length).toBe(metadata.layers.length);
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
        for (const pick of decodeCadSceneTile(payload, tile)) expect(stored.has(pick.elementId)).toBe(true);
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
