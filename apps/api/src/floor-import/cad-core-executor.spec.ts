import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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
});

function validManifest() {
  return {
    profileId: "generic-lighting-v1" as const,
    profileVersion: "test/1",
    profileDigest: "b".repeat(64),
    modelEntityCount: 0,
    blockCount: 0,
    candidates: [],
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
      renderedOccurrences: 0,
      excludedEntityCount: 0,
      unsupportedEntityCounts: {},
      contentEncoding: "gzip" as const
    }
  };
}
