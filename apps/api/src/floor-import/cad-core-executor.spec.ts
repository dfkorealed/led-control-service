import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

  it.each([
    ["more than 2,000 selected candidates", (manifest: ReturnType<typeof validArtifactManifest>) => {
      manifest.selectedCandidates = Array.from({ length: 2_001 }, () => ({ ...manifest.selectedCandidates[0] }));
    }],
    ["a selected candidate outside the detected candidate subset", (manifest: ReturnType<typeof validArtifactManifest>) => {
      manifest.selectedCandidates[0].sourceEntityId = "foreign-entity";
    }],
    ["a selected candidate outside the selected scene coordinates", (manifest: ReturnType<typeof validArtifactManifest>) => {
      manifest.selectedCandidates[0].x = manifest.scene.width + 1;
    }],
    ["a candidate belonging to another detected region", (manifest: ReturnType<typeof validArtifactManifest>) => {
      const otherCandidate = {
        sourceEntityId: "other-region-light",
        layerName: "LIGHT",
        blockName: "LED",
        x: 0.75,
        y: 0.75,
        rotation: 30,
        confidence: 0.9,
        method: "rule" as const,
        sourcePosition: { x: 2_500, y: 450 }
      };
      manifest.candidates.push(otherCandidate);
      manifest.regions.push({
        regionId: "region-fedcba987654321001234567",
        bounds: { minX: 2_000, minY: 0, maxX: 3_000, maxY: 900 },
        primitiveCount: 4,
        textCount: 0,
        lightCandidateCount: 1,
        area: 900_000
      });
      manifest.modelEntityCount = 8;
      manifest.rendered.renderedOccurrences = 8;
      manifest.candidateTransformMatch = {
        candidateCount: 2,
        matchedCount: 2,
        matchRate: 1,
        tolerancePx: 0.01,
        maxDeltaPx: 0
      };
      manifest.candidateRegionAssignments.push({
        sourceEntityId: otherCandidate.sourceEntityId,
        regionId: manifest.regions[1].regionId
      });
      manifest.selectedCandidates[0] = { ...otherCandidate, x: 100, y: 100 };
    }],
    ["an in-bounds transformed selected candidate coordinate", (manifest: ReturnType<typeof validArtifactManifest>) => {
      manifest.selectedCandidates[0].x += 1;
      manifest.selectedCandidates[0].y -= 1;
    }],
    ["a transformed selected candidate rotation", (manifest: ReturnType<typeof validArtifactManifest>) => {
      manifest.selectedCandidates[0].rotation += 15;
    }],
    ["an invalid selected candidate field", (manifest: ReturnType<typeof validArtifactManifest>) => {
      manifest.selectedCandidates[0].confidence = 2;
    }]
  ])("rejects a malformed artifact child response containing %s", async (_caseName, mutate) => {
    const root = await mkdtemp(join(tmpdir(), "cad-core-selected-candidates-"));
    const child = join(root, "malformed-artifact.cjs");
    const manifest = validArtifactManifest();
    mutate(manifest);
    const response = JSON.stringify({ ok: true, result: manifest });
    await writeFile(child, `process.on("message", () => {
      process.stdout.write(${JSON.stringify(response)}, () => process.exit(0));
    });`);
    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 32, timeoutMs: 5_000 });
      await expect(executor.execute({
        dxfPath: "unused",
        renderedPath: "unused",
        artifactDirectory: root,
        jobId: "33333333-3333-4333-8333-333333333333",
        selectedRegionId: manifest.regions[0].regionId,
        expectedCandidateRegionDigests: Object.fromEntries(manifest.regions.map((region: { regionId: string }) => [
          region.regionId,
          candidateIdentityDigest(manifest.candidateRegionAssignments
            .filter((assignment: { regionId: string }) => assignment.regionId === region.regionId)
            .map((assignment: { sourceEntityId: string }) => assignment.sourceEntityId))
        ])),
        profileId: "generic-lighting-v1"
      })).rejects.toThrow(/bounded manifest/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts an occurrence-assigned candidate whose INSERT point is outside the selected region bounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-core-occurrence-assignment-"));
    const child = join(root, "occurrence-assignment.cjs");
    const manifest = validArtifactManifest();
    manifest.candidates[0].sourcePosition = { x: 1_700, y: 900 };
    manifest.selectedCandidates[0].x = 425;
    manifest.selectedCandidates[0].y = 256;
    const response = JSON.stringify({ ok: true, result: manifest });
    await writeFile(child, `process.on("message", () => {
      process.stdout.write(${JSON.stringify(response)}, () => process.exit(0));
    });`);
    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 32, timeoutMs: 5_000 });
      await expect(executor.execute({
        dxfPath: "unused",
        renderedPath: "unused",
        artifactDirectory: root,
        jobId: "33333333-3333-4333-8333-333333333333",
        selectedRegionId: manifest.regions[0].regionId,
        expectedCandidateRegionDigests: {
          [manifest.regions[0].regionId]: candidateIdentityDigest([manifest.candidates[0].sourceEntityId])
        },
        profileId: "generic-lighting-v1"
      })).resolves.toMatchObject({
        selectedCandidates: [expect.objectContaining({ sourceEntityId: "selected-light", x: 425, y: 256 })]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a selected-region execution without a parent canonical digest map", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-core-missing-canonical-map-"));
    const child = join(root, "missing-canonical-map.cjs");
    const manifest = validArtifactManifest();
    const response = JSON.stringify({ ok: true, result: manifest });
    await writeFile(child, `process.on("message", () => {
      process.stdout.write(${JSON.stringify(response)}, () => process.exit(0));
    });`);
    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 32, timeoutMs: 5_000 });
      await expect(executor.execute({
        dxfPath: "unused",
        renderedPath: "unused",
        artifactDirectory: root,
        jobId: "33333333-3333-4333-8333-333333333333",
        selectedRegionId: manifest.regions[0].regionId,
        profileId: "generic-lighting-v1"
      })).rejects.toThrow(/bounded manifest/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a coherent reassignment that disagrees with the parent canonical digest map", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-core-canonical-assignment-"));
    const child = join(root, "coherent-reassignment.cjs");
    const manifest = validArtifactManifest();
    const selectedRegionId = manifest.regions[0].regionId;
    const otherRegionId = "region-fedcba987654321001234567";
    const otherCandidate = {
      sourceEntityId: "other-region-light",
      layerName: "LIGHT",
      blockName: "LED",
      x: 0.75,
      y: 0.75,
      rotation: 30,
      confidence: 0.9,
      method: "rule" as const,
      sourcePosition: { x: 2_500, y: 450 }
    };
    manifest.candidates.push(otherCandidate);
    manifest.regions.push({
      regionId: otherRegionId,
      bounds: { minX: 2_000, minY: 0, maxX: 3_000, maxY: 900 },
      primitiveCount: 4,
      textCount: 0,
      lightCandidateCount: 1,
      area: 900_000
    });
    manifest.modelEntityCount = 8;
    manifest.rendered.renderedOccurrences = 8;
    manifest.candidateTransformMatch = {
      candidateCount: 2,
      matchedCount: 2,
      matchRate: 1,
      tolerancePx: 0.01,
      maxDeltaPx: 0
    };
    manifest.candidateRegionAssignments.push({
      sourceEntityId: otherCandidate.sourceEntityId,
      regionId: otherRegionId
    });
    const expectedCandidateRegionDigests = {
      [selectedRegionId]: candidateIdentityDigest([manifest.candidates[0].sourceEntityId]),
      [otherRegionId]: candidateIdentityDigest([otherCandidate.sourceEntityId])
    };

    manifest.candidateRegionAssignments[0].regionId = otherRegionId;
    manifest.regions[0].lightCandidateCount = 0;
    manifest.regions[1].lightCandidateCount = 2;
    manifest.selectedCandidates = [];
    const response = JSON.stringify({ ok: true, result: manifest });
    await writeFile(child, `process.on("message", request => {
      const payload = Object.prototype.hasOwnProperty.call(request, "expectedCandidateRegionDigests")
        ? JSON.stringify({ ok: false, code: "TRUSTED_DIGEST_MAP_LEAKED_TO_CHILD" })
        : ${JSON.stringify(response)};
      process.stdout.write(payload, () => process.exit(0));
    });`);

    try {
      const executor = new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 32, timeoutMs: 5_000 });
      await expect(executor.execute({
        dxfPath: "unused",
        renderedPath: "unused",
        artifactDirectory: root,
        jobId: "33333333-3333-4333-8333-333333333333",
        selectedRegionId,
        expectedCandidateRegionDigests,
        profileId: "generic-lighting-v1"
      })).rejects.toThrow(/bounded manifest/i);
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

function validArtifactManifest() {
  const manifest: any = validManifest();
  const candidate = {
    sourceEntityId: "selected-light",
    layerName: "LIGHT",
    blockName: "LED",
    x: 0.5,
    y: 0.5,
    rotation: 0,
    confidence: 0.95,
    method: "rule" as const,
    sourcePosition: { x: 512, y: 900 }
  };
  manifest.modelEntityCount = 4;
  manifest.candidates = [candidate];
  manifest.regions[0].lightCandidateCount = 1;
  manifest.candidateTransformMatch = {
    candidateCount: 1,
    matchedCount: 1,
    matchRate: 1,
    tolerancePx: 0.01,
    maxDeltaPx: 0
  };
  return {
    ...manifest,
    canonical: {
      elements: { filename: "33333333-3333-4333-8333-333333333333.ndjson.gzf", byteSize: 100, sha256: "e".repeat(64),
        codec: "gzip-frames", version: 1, decodedByteSize: 500, decodedSha256: "a".repeat(64) },
      metadata: { filename: "44444444-4444-4444-8444-444444444444.json", byteSize: 100, sha256: "f".repeat(64) },
      elementCount: 1
    },
    selectedCandidates: [{ ...candidate, x: 128, y: 256 }],
    candidateRegionAssignments: [{
      sourceEntityId: candidate.sourceEntityId,
      regionId: manifest.regions[0].regionId
    }],
    regionPreviews: [],
    scene: {
      sceneId: "11111111-1111-4111-8111-111111111111",
      manifestAssetId: "22222222-2222-4222-8222-222222222222",
      manifestFilename: "22222222-2222-4222-8222-222222222222.json",
      manifestByteSize: 512,
      manifestSha256: "d".repeat(64),
      width: 512,
      height: 512,
      sourceBounds: { ...manifest.regions[0].bounds },
      transform: { scaleX: 0.25, scaleY: -0.25, translateX: 0, translateY: 481 }
    }
  };
}

function candidateIdentityDigest(sourceEntityIds: string[]): string {
  const identities = sourceEntityIds.map(value => value.normalize("NFKC").toUpperCase()).sort();
  return createHash("sha256").update(JSON.stringify(identities), "utf8").digest("hex");
}
