import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  CAD_CORE_MAX_OLD_SPACE_MB,
  CAD_CORE_RESPONSE_MAX_BYTES,
  ChildProcessCadCoreExecutor,
  assertCoreManifest,
  encodeCadCoreResponse
} from "./cad-core-executor";
import { detectCadRegions } from "./cad-region-detector";
import type { NormalizedCadDocument, NormalizedCadEntity } from "./cad-types";

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

  it("rejects a valid bounded manifest when the child exits non-zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-core-nonzero-"));
    const child = join(root, "nonzero.cjs");
    const response = JSON.stringify({ ok: true, result: validManifest() });
    await writeFile(child, `process.on("message", () => {
      process.stdout.write(${JSON.stringify(response)}, () => process.exit(7));
    });`);
    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 32, timeoutMs: 5_000 });
      await expect(executor.execute({ dxfPath: "unused", renderedPath: "unused", profileId: "generic-lighting-v1" }))
        .rejects.toThrow(/child process failed \(7\)/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects and kills a child whose stderr exceeds the bounded diagnostic limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-core-stderr-limit-"));
    const child = join(root, "stderr-overflow.cjs");
    await writeFile(child, `process.on("message", () => {
      process.stderr.write("x".repeat(${64 * 1024 + 1}));
      setInterval(() => {}, 1000);
    });`);
    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 32, timeoutMs: 5_000 });
      await expect(executor.execute({ dxfPath: "unused", renderedPath: "unused", profileId: "generic-lighting-v1" }))
        .rejects.toThrow(/stderr byte limit/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a child spawn error before any stdout response", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      connected: false,
      killed: false,
      disconnect: jest.fn(),
      kill: jest.fn(() => true),
      send: jest.fn()
    });
    const forkProcess = jest.fn(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn EACCES")));
      return child;
    });
    const executor = new ChildProcessCadCoreExecutor({
      maxOldSpaceMb: 32,
      timeoutMs: 5_000,
      forkProcess: forkProcess as never
    });

    await expect(executor.execute({ dxfPath: "unused", renderedPath: "unused", profileId: "generic-lighting-v1" }))
      .rejects.toThrow("CAD core child process failed");
    expect(forkProcess).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
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
      process.stdout.write(JSON.stringify({ ok: true, result }), () => process.exit(0));
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
      process.stdout.write(JSON.stringify({ ok: true, result: {
        profileId: "generic-lighting-v1", profileVersion: "v", profileDigest: "${"b".repeat(64)}", modelEntityCount: 1, blockCount: 0,
        candidates: [{ sourceEntityId: "one", layerName: "LIGHT", blockName: "LED", x: 1, y: 1, rotation: 0, confidence: 1, method: "rule" }],
        candidateTransformMatch: { candidateCount: 1, matchedCount: 0, matchRate: 0, tolerancePx: 0.01, maxDeltaPx: 2 },
        rendered: { sizeBytes: 1, rawSizeBytes: 1, sha256: "${"c".repeat(64)}", viewport: { width: 1, height: 1 }, renderedOccurrences: 1, contentEncoding: "gzip" }
      } }), () => process.exit(0));
    });`);
    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 32, timeoutMs: 5_000 });
      await expect(executor.execute({ dxfPath: "unused", renderedPath: "unused", profileId: "generic-lighting-v1" }))
        .rejects.toThrow(/manifest/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a manifest with more unique unsupported types than the bounded contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-core-unsupported-manifest-"));
    const child = join(root, "unsupported.cjs");
    await writeFile(child, `process.on("message", () => {
      const unsupportedEntityCounts = Object.fromEntries(Array.from({ length: 65 }, (_, index) => ["TYPE_" + index, 1]));
      process.stdout.write(JSON.stringify({ ok: true, result: {
        profileId: "generic-lighting-v1", profileVersion: "v", profileDigest: "${"b".repeat(64)}", modelEntityCount: 0, blockCount: 0,
        candidates: [], candidateTransformMatch: { candidateCount: 0, matchedCount: 0, matchRate: null, tolerancePx: 0.01, maxDeltaPx: 0 },
        rendered: { sizeBytes: 1, rawSizeBytes: 1, sha256: "${"c".repeat(64)}", viewport: { width: 1, height: 1 }, renderedOccurrences: 0, excludedEntityCount: 0, unsupportedEntityCounts, contentEncoding: "gzip" }
      } }), () => process.exit(0));
    });`);
    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 32, timeoutMs: 5_000 });
      await expect(executor.execute({ dxfPath: "unused", renderedPath: "unused", profileId: "generic-lighting-v1" }))
        .rejects.toThrow(/bounded manifest/i);
      expect(process.pid).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("kills a child response before JSON parsing when stdout exceeds the transport byte limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-core-response-limit-"));
    const child = join(root, "oversized-response.cjs");
    await writeFile(child, `process.on("message", () => process.stdout.write("x".repeat(${8 * 1024 * 1024 + 1})));`);
    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 32, timeoutMs: 5_000 });
      await expect(executor.execute({ dxfPath: "unused", renderedPath: "unused", profileId: "generic-lighting-v1" }))
        .rejects.toThrow(/response byte limit/i);
      expect(process.pid).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate or inconsistent region manifests", () => {
    const duplicate = validManifest();
    duplicate.regions = [duplicate.regions[0], duplicate.regions[0]];
    expect(() => assertCoreManifest(duplicate, "generic-lighting-v1")).toThrow("invalid core manifest");

    const invalidBounds = validManifest();
    invalidBounds.regions[0] = {
      ...invalidBounds.regions[0],
      bounds: { minX: 10, minY: 0, maxX: 0, maxY: 10 }
    };
    expect(() => assertCoreManifest(invalidBounds, "generic-lighting-v1")).toThrow("invalid core manifest");
  });

  it("rejects region totals that do not cover every rendered primitive and light candidate", () => {
    const primitiveMismatch = validManifest();
    primitiveMismatch.rendered.renderedOccurrences = 3;
    expect(() => assertCoreManifest(primitiveMismatch, "generic-lighting-v1")).toThrow("invalid core manifest");

    const lightMismatch = validManifest();
    lightMismatch.regions[0].lightCandidateCount = 1;
    expect(() => assertCoreManifest(lightMismatch, "generic-lighting-v1")).toThrow("invalid core manifest");
  });

  it("accounts for excluded region noise without attributing it to a region", () => {
    const withExcludedNoise = validManifest();
    withExcludedNoise.excludedRegionPrimitiveCount = 2;
    withExcludedNoise.rendered.renderedOccurrences = 6;
    expect(() => assertCoreManifest(withExcludedNoise, "generic-lighting-v1")).not.toThrow();

    withExcludedNoise.rendered.renderedOccurrences = 5;
    expect(() => assertCoreManifest(withExcludedNoise, "generic-lighting-v1")).toThrow("invalid core manifest");
  });

  it("keeps a 150,000-point detector manifest within the child response boundary", () => {
    const entities: NormalizedCadEntity[] = [{
      type: "circle",
      sourceEntityId: "meaningful-anchor",
      layer: "0",
      center: { x: 0, y: 0, z: 0 },
      radius: 10
    }, ...Array.from({ length: 150_000 }, (_, index): NormalizedCadEntity => ({
      type: "point",
      sourceEntityId: `noise-${index}`,
      layer: "0",
      position: { x: (index + 1) * 1_000, y: 0, z: 0 }
    }))];
    const document: NormalizedCadDocument = {
      version: 1,
      bounds: { minX: -10, minY: -10, maxX: 150_000_000, maxY: 10 },
      blocks: [],
      entities
    };
    const manifest = validManifest();
    manifest.modelEntityCount = entities.length;
    const detected = detectCadRegions(document, { maxSpatialBuckets: 600_000 });
    manifest.regions = detected.regions;
    manifest.excludedRegionPrimitiveCount = detected.excludedPrimitiveCount;
    manifest.rendered.renderedOccurrences = entities.length;

    const encoded = encodeCadCoreResponse({ ok: true, result: manifest }, "generic-lighting-v1");

    expect(encoded.length).toBeLessThanOrEqual(CAD_CORE_RESPONSE_MAX_BYTES);
    expect(manifest.regions).toHaveLength(1);
    expect(manifest.regions[0].primitiveCount).toBe(1);
    expect(manifest.excludedRegionPrimitiveCount).toBe(150_000);
  }, 60_000);
});

function validManifest() {
  return {
    profileId: "generic-lighting-v1" as const,
    profileVersion: "test/1",
    profileDigest: "b".repeat(64),
    modelEntityCount: 0,
    blockCount: 0,
    candidates: [],
    excludedRegionPrimitiveCount: 0,
    regions: [{
      regionId: "region-0123456789abcdef01234567",
      bounds: { minX: 0, minY: 0, maxX: 1_600, maxY: 900 },
      primitiveCount: 4,
      textCount: 0,
      lightCandidateCount: 0,
      area: 1_440_000
    }],
    candidateTransformMatch: {
      candidateCount: 0,
      matchedCount: 0,
      matchRate: null,
      tolerancePx: 0.01,
      maxDeltaPx: 0
    },
    rendered: {
      sizeBytes: 1,
      rawSizeBytes: 1,
      sha256: "c".repeat(64),
      viewport: { width: 1, height: 1 },
      renderedOccurrences: 4,
      excludedEntityCount: 0,
      unsupportedEntityCounts: {},
      contentEncoding: "gzip" as const
    }
  };
}
