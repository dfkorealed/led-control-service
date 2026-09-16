import { describe, expect, it } from "vitest";
import {
  CAD_IMPORT_MIME_TYPES,
  cadImportFileTypeSchema,
  floorImportApplyInputSchema,
  floorImportCandidateListResponseSchema,
  floorImportJobStatusSchema,
  floorImportRenderedViewportSchema
} from "./cad-import-contracts";

const jobId = "00000000-0000-4000-8000-000000000001";
const candidateId = "00000000-0000-4000-8000-000000000002";

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
      "review_required",
      "applying",
      "completed",
      "failed",
      "cancelled"
    ]);
    expect(floorImportJobStatusSchema.safeParse("ready").success).toBe(false);
  });

  it("validates the rendered CAD viewport used by both preview and candidates", () => {
    expect(floorImportRenderedViewportSchema.parse({ width: 640, height: 360 }))
      .toEqual({ width: 640, height: 360 });
    expect(floorImportRenderedViewportSchema.safeParse({ width: 0, height: 360 }).success).toBe(false);
    expect(floorImportRenderedViewportSchema.safeParse({ width: 640, height: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(floorImportRenderedViewportSchema.safeParse({ width: 640, height: 360, scale: 2 }).success).toBe(false);
  });

  it("validates a strict candidate list response", () => {
    expect(floorImportCandidateListResponseSchema.parse(candidateResponse)).toEqual(candidateResponse);
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
      .toEqual([ruleBased, aiAssisted]);
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
      candidateIds: [candidateId]
    };

    expect(floorImportApplyInputSchema.parse(input)).toEqual(input);
    expect(floorImportApplyInputSchema.safeParse({ ...input, expectedRevision: -1 }).success).toBe(false);
    expect(floorImportApplyInputSchema.safeParse({ ...input, leaseFence: 0 }).success).toBe(false);
    expect(floorImportApplyInputSchema.safeParse({ ...input, candidateIds: [...input.candidateIds, candidateId] }).success).toBe(false);
    expect(floorImportApplyInputSchema.safeParse({ ...input, fixtureIds: [] }).success).toBe(false);
    expect(floorImportApplyInputSchema.safeParse({
      ...input,
      candidateIds: Array.from({ length: 1_001 }, (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`)
    }).success).toBe(false);
  });
});
