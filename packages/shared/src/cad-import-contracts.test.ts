import { describe, expect, it } from "vitest";
import {
  CAD_IMPORT_MAX_CANDIDATES,
  CAD_IMPORT_MIME_TYPES,
  cadImportStageLabel,
  cadImportStageSchema,
  cadImportFileTypeSchema,
  floorImportApplyInputSchema,
  floorImportApplyResultSchema,
  floorImportAppliedOverlayResponseSchema,
  floorImportCandidateListResponseSchema,
  floorImportJobStatusSchema,
  floorImportRenderedViewportSchema,
  floorImportRegionListResponseSchema
} from "./cad-import-contracts";
import { floorEditorSnapshotSchema, floorLightSlotSchema, POSTGRES_INT_MAX } from "./schemas";

const jobId = "00000000-0000-4000-8000-000000000001";
const candidateId = "00000000-0000-4000-8000-000000000002";
const slotId = "00000000-0000-4000-8000-000000000003";
const legacyProfileMetadata = {
  profileVersion: "legacy-unknown",
  profileDigest: "0".repeat(64)
};

const candidateResponse = {
  jobId,
  candidates: [{
    id: candidateId,
    sourceEntityId: "entity-42",
    layerName: "LIGHTING",
    blockName: "LED_FIXTURE",
    x: 125.5,
    y: 240,
    rotation: 90,
    confidence: 0.92,
    detectionMethod: "rule_based" as const,
    provider: null,
    model: null,
    inputDigest: null,
    reviewStatus: "pending" as const
  }]
};

describe("CAD import contracts", () => {
  function regionList(count: number, unicode = false) {
    return {
      jobId, selectionStatus: "selection_required", selectedRegionId: null,
      excludedRegionPrimitiveCount: 0,
      regions: Array.from({ length: count }, (_, index) => ({
        regionId: `${unicode ? "한".repeat(500) : "region-"}${index}`,
        bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
        primitiveCount: 2, textCount: 1, lightCandidateCount: 0, area: 10_000,
        preview: { assetId: candidateId, width: 100, height: 100, byteSize: 64, sha256: "a".repeat(64) }
      }))
    };
  }

  it("accepts all 1817 regions and the detector ceiling without truncation", () => {
    expect(floorImportRegionListResponseSchema.parse(regionList(1817)).regions).toHaveLength(1817);
    expect(floorImportRegionListResponseSchema.parse(regionList(16384)).regions).toHaveLength(16384);
    expect(floorImportRegionListResponseSchema.safeParse(regionList(16385)).success).toBe(false);
  });

  it("bounds serialized region response UTF-8 bytes to 16 MiB, not character count", () => {
    const response = regionList(10000, true);
    expect(JSON.stringify(response).length).toBeLessThan(16 * 1024 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeGreaterThan(16 * 1024 * 1024);
    expect(floorImportRegionListResponseSchema.safeParse(response).success).toBe(false);
  });

  it("validates persistent light slots in editor snapshots", () => {
    const slot = {
      id: slotId,
      x: 120,
      y: 240,
      rotation: 0,
      assignedFixtureId: null
    };

    expect(floorLightSlotSchema.parse(slot)).toMatchObject({ assignedFixtureId: null });
    expect(floorEditorSnapshotSchema.parse({
      version: 2,
      floorPlan: null,
      fixtures: [],
      objects: [],
      lightSlots: [slot]
    })).toMatchObject({ lightSlots: [slot] });
    expect(() => floorEditorSnapshotSchema.parse({
      version: 2,
      floorPlan: null,
      fixtures: [],
      objects: [],
      lightSlots: [{ ...slot, sourceImportJobId: "00000000-0000-4000-8000-000000000091" }]
    })).toThrow();
    expect(() => floorLightSlotSchema.parse({ ...slot, x: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("preserves the bounded 2,000 candidate review/apply contract", () => {
    expect(CAD_IMPORT_MAX_CANDIDATES).toBe(2_000);
    const candidates = Array.from({ length: 1_308 }, (_, index) => ({
      ...candidateResponse.candidates[0],
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sourceEntityId: `entity-${index}`
    }));
    expect(floorImportCandidateListResponseSchema.safeParse({ jobId, candidates }).success).toBe(true);
    expect(floorImportApplyInputSchema.safeParse({
      expectedRevision: 3, leaseToken: "lease-token", leaseFence: 7,
      confirmMapReset: true,
      candidateIds: candidates.map(candidate => candidate.id)
    }).success).toBe(true);
    const excessive = [...candidates, ...Array.from({ length: 693 }, (_, offset) => ({
      ...candidateResponse.candidates[0],
      id: `00000000-0000-4000-8001-${String(offset).padStart(12, "0")}`,
      sourceEntityId: `extra-${offset}`
    }))];
    expect(floorImportCandidateListResponseSchema.safeParse({ jobId, candidates: excessive }).success).toBe(false);
  });

  it("accepts only known DWG/DXF MIME types paired with their source format", () => {
    for (const mimeType of CAD_IMPORT_MIME_TYPES.dwg) {
      expect(cadImportFileTypeSchema.parse({ sourceFormat: "dwg", mimeType })).toEqual({
        sourceFormat: "dwg",
        mimeType
      });
    }
    for (const mimeType of CAD_IMPORT_MIME_TYPES.dxf) {
      expect(cadImportFileTypeSchema.parse({ sourceFormat: "dxf", mimeType })).toEqual({
        sourceFormat: "dxf",
        mimeType
      });
    }

    expect(cadImportFileTypeSchema.safeParse({ sourceFormat: "dwg", mimeType: "application/dxf" }).success).toBe(false);
    expect(cadImportFileTypeSchema.safeParse({ sourceFormat: "dxf", mimeType: "application/pdf" }).success).toBe(false);
    expect(cadImportFileTypeSchema.safeParse({ sourceFormat: "pdf", mimeType: "application/pdf" }).success).toBe(false);
    expect(cadImportFileTypeSchema.safeParse({ sourceFormat: "dwg", mimeType: "application/dwg", extra: true }).success).toBe(false);
  });

  it("accepts exactly the persisted CAD import job states", () => {
    expect(floorImportJobStatusSchema.options).toEqual([
      "queued",
      "processing",
      "region_selection_required",
      "review_required",
      "applying",
      "completed",
      "failed",
      "cancelled"
    ]);
    expect(floorImportJobStatusSchema.safeParse("ready").success).toBe(false);
  });

  it("exposes region detection, selection, and scene compilation stages", () => {
    expect(cadImportStageSchema.options).toEqual([
      "queued",
      "downloading",
      "converting",
      "parsing",
      "detecting_regions",
      "region_selection_required",
      "compiling_scene",
      "rendering",
      "persisting",
      "review_required",
      "applying",
      "completed",
      "failed",
      "cancelled"
    ]);
    expect(cadImportStageLabel("detecting_regions")).toBe("도면 영역을 찾는 중");
    expect(cadImportStageLabel("region_selection_required")).toBe("가져올 도면 영역 선택 필요");
    expect(cadImportStageLabel("compiling_scene")).toBe("CAD 장면을 만드는 중");
  });

  it("validates the rendered CAD viewport used by both preview and candidates", () => {
    expect(floorImportRenderedViewportSchema.parse({ width: 640, height: 360 }))
      .toEqual({ width: 640, height: 360 });
    expect(floorImportRenderedViewportSchema.safeParse({ width: 0, height: 360 }).success).toBe(false);
    expect(floorImportRenderedViewportSchema.safeParse({ width: 640, height: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(floorImportRenderedViewportSchema.safeParse({ width: 640, height: 360, scale: 2 }).success).toBe(false);
  });

  it("validates a strict candidate list response", () => {
    expect(floorImportCandidateListResponseSchema.parse(candidateResponse)).toEqual({
      ...candidateResponse,
      candidates: candidateResponse.candidates.map(candidate => ({ ...candidate, ...legacyProfileMetadata }))
    });
    expect(floorImportCandidateListResponseSchema.safeParse({ ...candidateResponse, total: 1 }).success).toBe(false);
    expect(floorImportCandidateListResponseSchema.safeParse({
      ...candidateResponse,
      candidates: [{ ...candidateResponse.candidates[0], confidence: 1.01 }]
    }).success).toBe(false);
    expect(floorImportCandidateListResponseSchema.safeParse({
      ...candidateResponse,
      candidates: [{ ...candidateResponse.candidates[0], x: Number.POSITIVE_INFINITY }]
    }).success).toBe(false);
    expect(floorImportCandidateListResponseSchema.safeParse({
      ...candidateResponse,
      candidates: [{ ...candidateResponse.candidates[0], fixtureId: candidateId }]
    }).success).toBe(false);
  });

  it("requires reproducibility metadata only for AI-assisted candidates", () => {
    const ruleBased = candidateResponse.candidates[0];
    const aiAssisted = {
      ...ruleBased,
      detectionMethod: "ai_assisted" as const,
      provider: "openai",
      model: "cad-symbol-classifier-v1",
      inputDigest: "a".repeat(64)
    };

    expect(floorImportCandidateListResponseSchema.parse({ jobId, candidates: [ruleBased, aiAssisted] }).candidates)
      .toEqual([
        { ...ruleBased, ...legacyProfileMetadata },
        { ...aiAssisted, ...legacyProfileMetadata }
      ]);
    expect(floorImportCandidateListResponseSchema.safeParse({
      jobId,
      candidates: [{ ...aiAssisted, inputDigest: null }]
    }).success).toBe(false);
    expect(floorImportCandidateListResponseSchema.safeParse({
      jobId,
      candidates: [{ ...aiAssisted, inputDigest: "not-a-sha256" }]
    }).success).toBe(false);
    expect(floorImportCandidateListResponseSchema.safeParse({
      jobId,
      candidates: [{ ...ruleBased, provider: "rules" }]
    }).success).toBe(false);
  });

  it("validates a strict apply input fenced by editor lease and revision", () => {
    const input = {
      expectedRevision: 3,
      leaseToken: "lease-token",
      leaseFence: 7,
      confirmMapReset: true,
      candidateIds: [candidateId]
    };

    expect(floorImportApplyInputSchema.parse(input)).toEqual(input);
    expect(() => floorImportApplyInputSchema.parse({
      expectedRevision: 4,
      leaseToken: "lease",
      leaseFence: 2,
      candidateIds: [candidateId]
    })).toThrow();
    expect(() => floorImportApplyInputSchema.parse({ ...input, confirmMapReset: false })).toThrow();
    expect(floorImportApplyInputSchema.safeParse({ ...input, expectedRevision: -1 }).success).toBe(false);
    expect(floorImportApplyInputSchema.safeParse({ ...input, leaseFence: 0 }).success).toBe(false);
    expect(floorImportApplyInputSchema.safeParse({ ...input, candidateIds: [...input.candidateIds, candidateId] }).success).toBe(false);
    expect(floorImportApplyInputSchema.safeParse({ ...input, fixtureIds: [] }).success).toBe(false);
    expect(floorImportApplyInputSchema.safeParse({
      ...input,
      candidateIds: Array.from({ length: 2_001 }, (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`)
    }).success).toBe(false);
  });

  it("validates the complete atomic map reset result", () => {
    const result = {
      jobId,
      status: "completed",
      revision: 4,
      acceptedCandidateIds: [candidateId],
      renderedAssetId: "00000000-0000-4000-8000-000000000004",
      deletedObjectCount: 2,
      unplacedFixtureCount: 4,
      deletedSlotCount: 1,
      createdSlotCount: 1,
      floorPlan: {
        imageUrl: "/api/floors/floor/assets/rendered/content",
        sourceType: "image",
        originalFileUrl: "/api/floors/floor/assets/source/content",
        renderedImageUrl: "/api/floors/floor/assets/rendered/content",
        width: 640,
        height: 480,
        gridSize: 10
      }
    };

    expect(floorImportApplyResultSchema.parse(result)).toEqual(result);
    for (const field of ["deletedObjectCount", "unplacedFixtureCount", "deletedSlotCount", "createdSlotCount"] as const) {
      const { [field]: _missing, ...incomplete } = result;
      expect(floorImportApplyResultSchema.safeParse(incomplete).success).toBe(false);
    }
    expect(floorImportApplyResultSchema.safeParse({ ...result, unexpectedCount: 1 }).success).toBe(false);
    expect(floorImportApplyResultSchema.safeParse({
      ...result,
      floorPlan: { ...result.floorPlan, sourceType: "cad" }
    }).success).toBe(true);
  });

  it("accepts full-floor output counts through the PostgreSQL Int boundary", () => {
    const result = {
      jobId,
      status: "completed",
      revision: POSTGRES_INT_MAX,
      acceptedCandidateIds: [candidateId],
      renderedAssetId: "00000000-0000-4000-8000-000000000004",
      deletedObjectCount: 2_001,
      unplacedFixtureCount: 1_001,
      deletedSlotCount: CAD_IMPORT_MAX_CANDIDATES,
      createdSlotCount: CAD_IMPORT_MAX_CANDIDATES,
      floorPlan: {
        imageUrl: "/api/floors/floor/assets/rendered/content",
        sourceType: "image",
        originalFileUrl: "/api/floors/floor/assets/source/content",
        renderedImageUrl: "/api/floors/floor/assets/rendered/content",
        width: 640,
        height: 480,
        gridSize: 10
      }
    };

    expect(floorImportApplyResultSchema.parse(result)).toEqual(result);
    expect(floorImportApplyResultSchema.safeParse({
      ...result,
      deletedObjectCount: POSTGRES_INT_MAX,
      unplacedFixtureCount: POSTGRES_INT_MAX
    }).success).toBe(true);

    const limits = {
      revision: POSTGRES_INT_MAX,
      deletedObjectCount: POSTGRES_INT_MAX,
      unplacedFixtureCount: POSTGRES_INT_MAX,
      deletedSlotCount: CAD_IMPORT_MAX_CANDIDATES,
      createdSlotCount: CAD_IMPORT_MAX_CANDIDATES
    } as const;
    for (const [field, max] of Object.entries(limits)) {
      expect(floorImportApplyResultSchema.safeParse({ ...result, [field]: -1 }).success).toBe(false);
      expect(floorImportApplyResultSchema.safeParse({ ...result, [field]: max + 1 }).success).toBe(false);
    }
  });

  it("validates strict native apply results without weakening the legacy branch", () => {
    const native = {
      jobId, status: "completed", revision: 4, acceptedCandidateIds: [candidateId], renderedAssetId: null,
      deletedObjectCount: 2, unplacedFixtureCount: 4, deletedSlotCount: 1, createdSlotCount: 1,
      floorPlan: { imageUrl: "", sourceType: "none", originalFileUrl: null, renderedImageUrl: null,
        width: 1200, height: 800, gridSize: 10 },
      mapDocument: { formatVersion: 1, generationId: "generation", revision: 4, width: 1200, height: 800,
        gridSize: 10, elementCount: 1,
        manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 100, decodedByteSize: 200 } }
    };
    expect(floorImportApplyResultSchema.parse(native)).toEqual(native);
    expect(floorImportApplyResultSchema.parse({ ...native, renderedAssetId: jobId }).renderedAssetId).toBe(jobId);
    for (const key of Object.keys(native)) {
      const incomplete = { ...native } as Record<string, unknown>; delete incomplete[key];
      expect(floorImportApplyResultSchema.safeParse(incomplete).success).toBe(false);
    }
    for (const field of ["width", "height", "gridSize"] as const) {
      expect(floorImportApplyResultSchema.safeParse({ ...native,
        floorPlan: { ...native.floorPlan, [field]: native.floorPlan[field] + 1 } }).success).toBe(false);
    }
    for (const invalid of [
      { ...native, revision: 5 }, { ...native, mapDocument: null },
      { ...native, floorImportJobId: jobId }, { ...native, acceptedCandidates: 1 },
      { ...native, floorPlan: { ...native.floorPlan, sourceType: "cad" } },
      { ...native, floorPlan: { ...native.floorPlan, imageUrl: "/fake.svg" } },
      { ...native, floorPlan: { ...native.floorPlan, originalFileUrl: "/fake.dwg" } },
      { ...native, floorPlan: { ...native.floorPlan, renderedImageUrl: "/fake.svg" } },
      { ...native, mapDocument: { ...native.mapDocument, manifest: { ...native.mapDocument.manifest, sha256: "broken" } } },
      { ...native, renderedAssetId: "not-an-asset-id" }, { ...native, createdSlotCount: 2001 }
    ]) expect(floorImportApplyResultSchema.safeParse(invalid).success).toBe(false);
    const { mapDocument: _ref, ...legacy } = native;
    const legacyPlan = { imageUrl: "/rendered.svg", originalFileUrl: "/original.dwg", renderedImageUrl: "/rendered.svg",
      sourceType: "cad", width: 1200, height: 800, gridSize: 10 };
    expect(floorImportApplyResultSchema.safeParse({ ...legacy, floorPlan: legacyPlan }).success).toBe(false);
    expect(floorImportApplyResultSchema.safeParse({ ...legacy, renderedAssetId: jobId, floorPlan: legacyPlan }).success).toBe(true);
  });

  it("validates a nullable applied overlay containing accepted candidates only", () => {
    const response = {
      overlay: {
        floorId: "00000000-0000-4000-8000-000000000010",
        jobId,
        revision: 7,
        renderedAssetId: "00000000-0000-4000-8000-000000000011",
        renderedAssetPath: "/api/floors/00000000-0000-4000-8000-000000000010/assets/00000000-0000-4000-8000-000000000011/content",
        renderedViewport: { width: 640, height: 360 },
        appliedAt: "2026-09-17T00:00:00.000Z",
        candidates: [{ ...candidateResponse.candidates[0], reviewStatus: "accepted" as const }]
      }
    };

    expect(floorImportAppliedOverlayResponseSchema.parse(response)).toEqual({
      overlay: {
        ...response.overlay,
        candidates: response.overlay.candidates.map(candidate => ({ ...candidate, ...legacyProfileMetadata }))
      }
    });
    expect(floorImportAppliedOverlayResponseSchema.parse({ overlay: null })).toEqual({ overlay: null });
    expect(floorImportAppliedOverlayResponseSchema.safeParse({
      overlay: {
        ...response.overlay,
        candidates: [{ ...candidateResponse.candidates[0], reviewStatus: "pending" }]
      }
    }).success).toBe(false);
    expect(floorImportAppliedOverlayResponseSchema.safeParse({
      overlay: { ...response.overlay, fixtureIds: [candidateId] }
    }).success).toBe(false);
  });
});
