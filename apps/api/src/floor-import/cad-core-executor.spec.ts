import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAD_CORE_MAX_OLD_SPACE_MB,
  ChildProcessCadCoreExecutor
} from "./cad-core-executor";

describe("ChildProcessCadCoreExecutor", () => {
  it("pins the production child heap and keeps the parent alive after child OOM", async () => {
    expect(CAD_CORE_MAX_OLD_SPACE_MB).toBe(384);
    const root = await mkdtemp(join(tmpdir(), "cad-core-oom-"));
    const child = join(root, "oom.cjs");
    await writeFile(child, `const chunks=[]; while(true) chunks.push(new Array(1_000_000).fill(1));`);
    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 16, timeoutMs: 10_000 });
      await expect(executor.execute({ dxfPath: "unused", renderedPath: "unused", profileId: "generic-lighting-v1" }))
        .rejects.toThrow(/child process/i);
      expect(process.pid).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("kills a stalled child at the bounded wall timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-core-timeout-"));
    const child = join(root, "stall.cjs");
    await writeFile(child, "setInterval(() => {}, 1000);");
    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 16, timeoutMs: 50 });
      await expect(executor.execute({ dxfPath: "unused", renderedPath: "unused", profileId: "generic-lighting-v1" }))
        .rejects.toThrow(/time limit/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an oversized IPC manifest before the API worker can persist it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-core-manifest-"));
    const child = join(root, "oversized.cjs");
    await writeFile(child, `process.on("message", () => {
      const result = {
        profileId: "generic-lighting-v1", profileVersion: "v", profileDigest: "${"b".repeat(64)}", modelEntityCount: 1, blockCount: 0,
        candidates: new Array(2001),
        rendered: { sizeBytes: 1, rawSizeBytes: 1, sha256: "${"c".repeat(64)}", viewport: { width: 1, height: 1 }, renderedOccurrences: 1, contentEncoding: "gzip" }
      };
      process.send({ ok: true, result });
    });`);
    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 32, timeoutMs: 5_000 });
      await expect(executor.execute({ dxfPath: "unused", renderedPath: "unused", profileId: "generic-lighting-v1" }))
        .rejects.toThrow(/manifest/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects inconsistent candidate-to-SVG transform evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-core-transform-manifest-"));
    const child = join(root, "invalid-transform.cjs");
    await writeFile(child, `process.on("message", () => {
      process.send({ ok: true, result: {
        profileId: "generic-lighting-v1", profileVersion: "v", profileDigest: "${"b".repeat(64)}", modelEntityCount: 1, blockCount: 0,
        candidates: [{ sourceEntityId: "one", layerName: "LIGHT", blockName: "LED", x: 1, y: 1, rotation: 0, confidence: 1, method: "rule" }],
        candidateTransformMatch: { candidateCount: 1, matchedCount: 0, matchRate: 0, tolerancePx: 0.01, maxDeltaPx: 2 },
        rendered: { sizeBytes: 1, rawSizeBytes: 1, sha256: "${"c".repeat(64)}", viewport: { width: 1, height: 1 }, renderedOccurrences: 1, contentEncoding: "gzip" }
      } });
    });`);
    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 32, timeoutMs: 5_000 });
      await expect(executor.execute({ dxfPath: "unused", renderedPath: "unused", profileId: "generic-lighting-v1" }))
        .rejects.toThrow(/manifest/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
