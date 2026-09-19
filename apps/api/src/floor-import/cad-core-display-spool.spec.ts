import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mapDisplayManifestSchema } from "@led-control/shared";
import { ChildProcessCadCoreExecutor } from "./cad-core-executor";
import { readCadDisplayTileIndex, withCadDisplayTileFile } from "./cad-display-tile-spool";
import { decodeMapDisplayTile } from "./cad-scene-codec";

it("production child writes only compressed internal tiles while publishing the exact raw v2 descriptors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cad-child-spool-"));
  try {
    const dxfPath = join(directory, "source.dxf");
    await writeFile(dxfPath, "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\nWALL\n10\n0\n20\n0\n11\n100\n21\n100\n0\nENDSEC\n0\nEOF\n");
    const entryPath = join(directory, "entry.cjs");
    await writeFile(entryPath, `require(${JSON.stringify(require.resolve("tsx/cjs"))}); require(${JSON.stringify(join(__dirname, "cad-core-child.ts"))});`);
    const executor = new ChildProcessCadCoreExecutor({ entryPath });
    const result = await executor.execute({ dxfPath, renderedPath: join(directory, "rendered.svg"),
      profileId: "generic-lighting-v1", artifactDirectory: directory, jobId: randomUUID() });
    expect(result.canonical?.displayTiles).toMatchObject({ codec: "gzip", version: 1 });
    expect((await readdir(directory)).filter(name => name.endsWith(".bin"))).toEqual([]);
    const scene = result.scene!;
    const manifest = mapDisplayManifestSchema.parse({ ...JSON.parse((await readFile(join(directory, scene.manifestFilename))).toString()),
      byteSize: scene.manifestByteSize, sha256: scene.manifestSha256 });
    const index = await readCadDisplayTileIndex(directory, result.canonical!.displayTiles, manifest);
    let count = 0;
    for (const tile of manifest.tiles) await withCadDisplayTileFile(directory, tile, index, async (_path, bytes) => {
      count += decodeMapDisplayTile(bytes, tile).length;
    });
    expect(count).toBeGreaterThan(0);
    expect((await readdir(directory)).filter(name => name.endsWith(".bin"))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);
