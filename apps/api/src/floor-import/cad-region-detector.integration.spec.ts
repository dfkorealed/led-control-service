import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChildProcessCadCoreExecutor } from "./cad-core-executor";

describe("CAD region detector child pipeline", () => {
  it("creates a validated region manifest from the normalized converter fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-region-pipeline-"));
    const entryPath = join(root, "cad-core-child.cjs");
    const renderedPath = join(root, "rendered.svg.gz");
    const childSource = resolve(__dirname, "cad-core-child.ts");
    const fixturePath = resolve(__dirname, "../../../../scripts/fixtures/cad-import/valid-mixed-layout.dxf");
    await writeFile(entryPath, `require(${JSON.stringify(require.resolve("tsx/cjs"))});require(${JSON.stringify(childSource)});`);

    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath, timeoutMs: 30_000 });
      const result = await executor.execute({
        dxfPath: fixturePath,
        renderedPath,
        profileId: "generic-lighting-v1"
      });

      expect(result).toMatchObject({
        modelEntityCount: 2,
        blockCount: 1,
        excludedRegionPrimitiveCount: 0,
        rendered: { renderedOccurrences: 2, viewport: { width: 2_400, height: 1_472 } }
      });
      expect(result.candidates).toHaveLength(0);
      expect(result.regions).toHaveLength(1);
      expect(result.regions[0]).toMatchObject({
        primitiveCount: 2,
        textCount: 0,
        lightCandidateCount: 0,
        bounds: { minX: 0, minY: 0, maxX: 10, maxY: 6 }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
