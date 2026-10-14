import { mapDisplayManifestSchema } from "@led-control/shared";
import { fork, type ForkOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChildProcessCadCoreExecutor } from "./cad-core-executor";
import { computeCandidateRegionDigests } from "./cad-candidate-region-digest";
import { cadRegionPreviewPersistenceIdentity, cadScenePersistenceIdentity } from "./cad-scene-persistence";
import { readCanonicalElements, readCanonicalMetadata } from "./cad-canonical-spool";
import { decodeMapDisplayTile } from "./cad-scene-codec";
import { readCadDisplayTileIndex, withCadDisplayTileFile } from "./cad-display-tile-spool";
import { gunzipSync } from "node:zlib";
import { parseAsciiDxfFile } from "./dxf-document-parser";

const enabled = process.env.CAD_CORE_CHILD_INTEGRATION === "1";

describe("CAD core child source encoding boundary", () => {
  it.each([
    ["CP949", Buffer.concat([Buffer.from("LIGHT_"), Buffer.from([0xb0, 0xa1, 0x81, 0x41])])],
    ["UTF-8", Buffer.from("LIGHT_\uac00\uac02")]
  ])("preserves %s symbol geometry and names without lighting candidates through the production child entry", async (_encoding, nameBytes) => {
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
      const executor = sourceExecutor();
      const result = await executor.execute({ dxfPath, renderedPath: join(directory, "whole.svg"), profileId: "generic-lighting-v1" });
      expect(result.modelEntityCount).toBe(2);
      expect(result.blockCount).toBe(1);
      expect(result.candidates).toEqual([]);
      expect(result.candidateRegionAssignments).toEqual([]);
      expect(result.regions.every(region => region.lightCandidateCount === 0)).toBe(true);
      const svg = gunzipSync(await readFile(join(directory, "whole.svg"))).toString("utf8");
      expect((await parseAsciiDxfFile(dxfPath)).blocks[0].name).toBe("LIGHT_\uac00\uac02");
      expect(svg.match(/<circle\b/g)).toHaveLength(1);
      expect(svg.match(/<use\b/g)).toHaveLength(2);
      expect(svg).toContain('matrix(1 0 0 1 10 0)');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

(enabled ? describe : describe.skip)("CAD core child native artifacts", () => {
  jest.setTimeout(60_000);

  it("preserves offset mirrored lighting symbols as canonical geometry without selected candidates", async () => {
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
    const executor = sourceExecutor();
    try {
      const detected = await executor.execute({ dxfPath, renderedPath: join(root, "whole.svg"), profileId: "generic-lighting-v1" });
      expect(detected.regions).toHaveLength(2);
      expect(detected.candidates).toEqual([]);
      const region = detected.regions.find(item => item.primitiveCount === 2)!;
      const selected = await executor.execute({
        dxfPath, renderedPath: join(selectedDirectory, "whole.svg"), profileId: "generic-lighting-v1",
        artifactDirectory: selectedDirectory, jobId: randomUUID(), selectedRegionId: region.regionId,
        expectedCandidateRegionDigests: computeCandidateRegionDigests(
          detected.regions.map(item => item.regionId), detected.candidateRegionAssignments ?? [],
          detected.candidates.map(candidate => candidate.sourceEntityId)
        )
      });
      expect(selected.selectedCandidates).toEqual([]);
      expect(selected.scene?.sourceBounds).toEqual(region.bounds);
      expect(selected.candidates).toEqual(detected.candidates);
      const symbols = [];
      for await (const element of readCanonicalElements(selectedDirectory, selected.canonical!)) symbols.push(element);
      expect(symbols).toHaveLength(2);
      for (const [index, symbol] of symbols.entries()) {
        const source = [{ x: -900, y: 1000 }, { x: -895, y: 1000 }][index];
        const transform = selected.scene!.transform;
        expect(symbol.type).toBe("ellipse");
        expect(symbol.transform.x).toBeCloseTo(source.x * transform.scaleX + transform.translateX, 9);
        expect(symbol.transform.y).toBeCloseTo(source.y * transform.scaleY + transform.translateY, 9);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(selectedDirectory, { recursive: true, force: true });
    }
  });

  it("keeps whole-document rendering and narrow lighting-symbol region coordinates without candidates", async () => {
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
    const executor = sourceExecutor();
    try {
      const detected = await executor.execute({ dxfPath, renderedPath: join(root, "whole.svg"), profileId: "generic-lighting-v1" });
      expect(detected.candidates).toEqual([]);
      const region = detected.regions.find(item => item.primitiveCount === 2)!;
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
      expect(selected.selectedCandidates).toEqual([]);
      expect(selected.scene?.sourceBounds).toEqual(region.bounds);
      const symbols = [];
      for await (const element of readCanonicalElements(selectedDirectory, selected.canonical!)) symbols.push(element);
      expect(symbols).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(selectedDirectory, { recursive: true, force: true });
    }
  });

  it("writes verified region previews and selected scene artifacts for a sample DXF", async () => {
    const firstDirectory = await mkdtemp(join(tmpdir(), "cad-core-regions-"));
    const selectedDirectory = await mkdtemp(join(tmpdir(), "cad-core-scene-"));
    const dxfPath = resolve(process.cwd(), "../../scripts/fixtures/cad-import/valid-mixed-layout.dxf");
    const executor = sourceExecutor();
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
      const manifest = mapDisplayManifestSchema.parse({
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
      expect(selected.candidates).toEqual([]);
      expect(selected.selectedCandidates).toEqual([]);
      expect(selected.candidateRegionAssignments).toEqual([]);
      expect(stored.size).toBeGreaterThan(0);
      expect(manifest.tiles.length).toBeGreaterThan(0);
      const index = await readCadDisplayTileIndex(selectedDirectory, selected.canonical!.displayTiles!, manifest);
      for (const tile of manifest.tiles) {
        await withCadDisplayTileFile(selectedDirectory, tile, index, async (_path, payload) => {
          expect(tile.assetId).toBe(identity.tileAssetId(tile));
          expect(payload.byteLength).toBe(tile.byteSize);
          expect(sha256(payload)).toBe(tile.sha256);
          for (const pick of decodeMapDisplayTile(payload, tile)) expect(stored.has(pick.elementId)).toBe(true);
        });
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

function sourceExecutor() {
  return new ChildProcessCadCoreExecutor({
    entryPath: resolve(process.cwd(), "src/floor-import/cad-core-child.ts"),
    forkProcess: (modulePath: string | URL, argsOrOptions?: readonly string[] | ForkOptions, options?: ForkOptions) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      const config = Array.isArray(argsOrOptions) ? options : argsOrOptions as ForkOptions | undefined;
      return fork(modulePath, args, {
        ...config, execArgv: [...(config?.execArgv ?? []), "--import", require.resolve("tsx")]
      });
    }
  });
}
