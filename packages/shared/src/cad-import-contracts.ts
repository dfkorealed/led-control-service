import { z } from "zod";
import { EDITOR_MAX_EXPECTED_REVISION, POSTGRES_INT_MAX } from "./schemas";

export const CAD_IMPORT_MAX_CANDIDATES = 2_000;
export const CAD_IMPORT_MIME_TYPES = {
  dwg: [
    "application/acad",
    "application/x-acad",
    "application/autocad",
    "application/dwg",
    "application/x-dwg",
    "application/vnd.autodesk.autocad.dwg",
    "image/vnd.dwg",
    "image/x-dwg"
  ],
  dxf: [
    "application/dxf",
    "application/x-dxf",
    "application/vnd.autodesk.autocad.dxf",
    "image/vnd.dxf",
    "image/x-dxf"
  ]
} as const;

export const cadImportSourceFormatSchema = z.enum(["dwg", "dxf"]);
export const cadImportMimeTypeSchema = z.enum([
  ...CAD_IMPORT_MIME_TYPES.dwg,
  ...CAD_IMPORT_MIME_TYPES.dxf
]);

export const cadImportFileTypeSchema = z.discriminatedUnion("sourceFormat", [
  z.object({
    sourceFormat: z.literal("dwg"),
    mimeType: z.enum(CAD_IMPORT_MIME_TYPES.dwg)
  }).strict(),
  z.object({
    sourceFormat: z.literal("dxf"),
    mimeType: z.enum(CAD_IMPORT_MIME_TYPES.dxf)
  }).strict()
]);

export const floorImportJobStatusSchema = z.enum([
  "queued",
  "processing",
  "review_required",
  "applying",
  "completed",
  "failed",
  "cancelled"
]);

export const cadImportStageSchema = z.enum([
  "queued",
  "downloading",
  "converting",
  "parsing",
  "rendering",
  "persisting",
  "review_required",
  "applying",
  "completed",
  "failed",
  "cancelled"
]);

export type CadImportStage = z.infer<typeof cadImportStageSchema>;

const CAD_IMPORT_STAGE_LABELS: Record<CadImportStage, string> = {
  queued: "가져오기 대기 중",
  downloading: "CAD 파일을 불러오는 중",
  converting: "CAD 도면을 변환하는 중",
  parsing: "CAD 도면을 분석하는 중",
  rendering: "도면 미리보기를 만드는 중",
  persisting: "분석 결과를 저장하는 중",
  review_required: "분석 완료",
  applying: "CAD 도면을 적용하는 중",
  completed: "CAD 도면을 적용했습니다.",
  failed: "CAD 가져오기에 실패했습니다.",
  cancelled: "CAD 가져오기가 취소되었습니다."
};

export function cadImportStageLabel(stage: string) {
  const parsed = cadImportStageSchema.safeParse(stage);
  return parsed.success ? CAD_IMPORT_STAGE_LABELS[parsed.data] : "CAD 가져오기 상태를 확인하는 중";
}

export const floorImportRenderedViewportSchema = z.object({
  width: z.number().int().positive().max(POSTGRES_INT_MAX),
  height: z.number().int().positive().max(POSTGRES_INT_MAX)
}).strict();

export const floorImportDetectionMethodSchema = z.enum(["rule_based", "ai_assisted"]);
export const floorImportCandidateReviewStatusSchema = z.enum(["pending", "accepted", "rejected"]);

export const floorImportCandidateSchema = z.object({
  id: z.string().uuid(),
  sourceEntityId: z.string().trim().min(1).max(512),
  layerName: z.string().trim().min(1).max(512),
  blockName: z.string().trim().min(1).max(512).nullable(),
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  rotation: z.number().finite(),
  confidence: z.number().finite().min(0).max(1),
  detectionMethod: floorImportDetectionMethodSchema,
  provider: z.string().trim().min(1).max(200).nullable(),
  model: z.string().trim().min(1).max(200).nullable(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  profileVersion: z.string().trim().min(1).max(128).default("legacy-unknown"),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/).default("0".repeat(64)),
  reviewStatus: floorImportCandidateReviewStatusSchema
}).strict().superRefine((candidate, context) => {
  const metadata = [candidate.provider, candidate.model, candidate.inputDigest];
  const valid = candidate.detectionMethod === "rule_based"
    ? metadata.every((value) => value === null)
    : metadata.every((value) => value !== null);
  if (!valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provider"],
      message: "AI-assisted candidates require complete reproducibility metadata; rule-based candidates forbid it"
    });
  }
});

export const floorImportCandidateListResponseSchema = z.object({
  jobId: z.string().uuid(),
  candidates: z.array(floorImportCandidateSchema).max(CAD_IMPORT_MAX_CANDIDATES)
}).strict();

export const floorImportAppliedOverlayResponseSchema = z.object({
  overlay: z.object({
    floorId: z.string().uuid(),
    jobId: z.string().uuid(),
    revision: z.number().int().nonnegative().max(EDITOR_MAX_EXPECTED_REVISION),
    renderedAssetId: z.string().uuid(),
    renderedAssetPath: z.string().trim().startsWith("/").max(2_048),
    renderedViewport: floorImportRenderedViewportSchema,
    appliedAt: z.string().datetime({ offset: true }),
    candidates: z.array(floorImportCandidateSchema).max(CAD_IMPORT_MAX_CANDIDATES)
  }).strict().superRefine((overlay, context) => {
    overlay.candidates.forEach((candidate, index) => {
      if (candidate.reviewStatus !== "accepted") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", index, "reviewStatus"],
          message: "applied overlays may expose accepted candidates only"
        });
      }
    });
  }).nullable()
}).strict();

export const floorImportApplyInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative().max(EDITOR_MAX_EXPECTED_REVISION),
  leaseToken: z.string().trim().min(1).max(256),
  leaseFence: z.number().int().positive().max(POSTGRES_INT_MAX),
  confirmMapReset: z.literal(true),
  candidateIds: z.array(z.string().uuid()).max(CAD_IMPORT_MAX_CANDIDATES)
}).strict().superRefine((input, context) => {
  if (new Set(input.candidateIds).size !== input.candidateIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidateIds"],
      message: "candidateIds must not contain duplicates"
    });
  }
});

export type CadImportSourceFormat = z.infer<typeof cadImportSourceFormatSchema>;
export type CadImportMimeType = z.infer<typeof cadImportMimeTypeSchema>;
export type FloorImportJobStatus = z.infer<typeof floorImportJobStatusSchema>;
export type FloorImportRenderedViewport = z.infer<typeof floorImportRenderedViewportSchema>;
export type FloorImportCandidate = z.infer<typeof floorImportCandidateSchema>;
export type FloorImportCandidateListResponse = z.infer<typeof floorImportCandidateListResponseSchema>;
export type FloorImportAppliedOverlayResponse = z.infer<typeof floorImportAppliedOverlayResponseSchema>;
export type FloorImportAppliedOverlay = NonNullable<FloorImportAppliedOverlayResponse["overlay"]>;
export type FloorImportApplyInput = z.infer<typeof floorImportApplyInputSchema>;
