import { z } from "zod";

const calendarDateSchema = z.string().date();
const uuidSchema = z.string().uuid();
const timestampSchema = z.string().datetime();

function addRangeIssue(
  range: { from: string; to: string },
  context: z.RefinementCtx,
  maximumInclusiveDays?: number
) {
  const from = Date.parse(`${range.from}T00:00:00.000Z`);
  const to = Date.parse(`${range.to}T00:00:00.000Z`);
  if (from > to) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "range must not end before it starts" });
    return;
  }

  if (maximumInclusiveDays !== undefined) {
    const inclusiveDays = Math.floor((to - from) / 86_400_000) + 1;
    if (inclusiveDays > maximumInclusiveDays) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: `range must not exceed ${maximumInclusiveDays} days` });
    }
  }
}

const dateRangeSchema = z.object({
  from: calendarDateSchema,
  to: calendarDateSchema
}).strict();

export const energyScopeSchema = z.enum(["site", "fixture", "floor", "group"]);
export const energyHeatmapMetricSchema = z.enum(["energy", "brightness"]);
export const energyReportFormatSchema = z.literal("pdf");
export const energyReportStatusSchema = z.enum(["queued", "processing", "completed", "failed", "expired"]);

const scopedRangeSchema = dateRangeSchema.extend({
  scope: energyScopeSchema,
  identityId: uuidSchema
});

export const energyHeatmapQuerySchema = scopedRangeSchema.extend({
  metric: energyHeatmapMetricSchema
}).strict().superRefine((query, context) => addRangeIssue(query, context, 92));

const heatmapCellSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  value: z.number().finite().nonnegative().nullable()
}).strict();

function validateOrderedHeatmapCells(
  cells: Array<{ weekday: number; hour: number }>,
  context: z.RefinementCtx,
  path: Array<string | number>
) {
  if (cells.length !== 168) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "heatmap must contain exactly 168 cells" });
    return;
  }

  cells.forEach((cell, index) => {
    const weekday = Math.floor(index / 24);
    const hour = index % 24;
    if (cell.weekday !== weekday || cell.hour !== hour) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: "heatmap cells must be ordered by weekday then hour"
      });
    }
  });
}

export const energyHeatmapResponseSchema = z.object({
  siteId: uuidSchema,
  timeZone: z.string().min(1),
  generatedAt: timestampSchema,
  metric: energyHeatmapMetricSchema,
  scope: energyScopeSchema,
  identityId: uuidSchema,
  range: dateRangeSchema,
  cells: z.array(heatmapCellSchema).length(168)
}).strict().superRefine((response, context) => {
  addRangeIssue(response.range, context, 92);
  validateOrderedHeatmapCells(response.cells, context, ["cells"]);
});

export const energyReportRequestSchema = scopedRangeSchema.extend({
  format: energyReportFormatSchema
}).strict().superRefine((request, context) => addRangeIssue(request, context));

/** CSV is a separate export, so its public range has no report file format. */
export const energyCsvExportQuerySchema = scopedRangeSchema.strict()
  .superRefine((query, context) => addRangeIssue(query, context));

/** Fixture/group IDs are analytics identities, never operational device/group IDs. */
export const energyReportTargetSchema = z.object({
  scope: energyScopeSchema, identityId: uuidSchema, label: z.string().min(1)
}).strict();

export const energyReportTargetsResponseSchema = z.object({
  siteId: uuidSchema,
  timeZone: z.string().min(1),
  lastCompletedDate: calendarDateSchema,
  targets: z.array(energyReportTargetSchema)
}).strict();

export const energyReportFailureCodeSchema = z.enum([
  "generation_failed", "storage_unavailable", "rendering_failed", "snapshot_invalid", "attempts_exhausted"
]);
export const energyReportFailureSchema = z.object({
  code: energyReportFailureCodeSchema, message: z.string().min(1), action: z.string().min(1)
}).strict();

const reportFailures = {
  REPORT_GENERATION_FAILED: { code: "generation_failed", message: "보고서를 생성하지 못했습니다.", action: "잠시 후 다시 생성해 주세요. 계속 실패하면 관리자에게 문의해 주세요." },
  REPORT_STORAGE_UNAVAILABLE: { code: "storage_unavailable", message: "보고서 파일 저장소를 사용할 수 없습니다.", action: "잠시 후 다시 생성해 주세요. 계속 실패하면 관리자에게 저장소 상태 확인을 요청해 주세요." },
  REPORT_RENDERING_FAILED: { code: "rendering_failed", message: "보고서 파일을 만드는 중 오류가 발생했습니다.", action: "다시 생성해 주세요. 계속 실패하면 관리자에게 기간과 대상을 알려 주세요." },
  REPORT_SNAPSHOT_INVALID: { code: "snapshot_invalid", message: "보고서의 대상 또는 데이터를 확인할 수 없습니다.", action: "대상과 완료된 날짜의 기간을 다시 선택해 생성해 주세요." },
  REPORT_ATTEMPTS_EXHAUSTED: { code: "attempts_exhausted", message: "보고서 생성 재시도 횟수를 초과했습니다.", action: "잠시 후 새로 생성해 주세요. 계속 실패하면 관리자에게 문의해 주세요." }
} as const satisfies Record<string, z.infer<typeof energyReportFailureSchema>>;

/** Legacy rows can hold unknown internal codes; only this allowlist crosses the API boundary. */
function publicReportFailure(code: string): { failureCode: string; failure: z.infer<typeof energyReportFailureSchema> } {
  const failureCode = Object.hasOwn(reportFailures, code) ? code as keyof typeof reportFailures : "REPORT_GENERATION_FAILED";
  return { failureCode, failure: { ...reportFailures[failureCode] } };
}

export const energyReportJobSchema = z.object({
  reportId: uuidSchema,
  siteId: uuidSchema,
  request: energyReportRequestSchema,
  status: energyReportStatusSchema,
  progressPercent: z.number().int().min(0).max(100),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
  expiresAt: timestampSchema.nullable(),
  failureCode: z.string().min(1).nullable(),
  // Missing fields are accepted from older servers and normalized below. Explicit
  // mismatches are rejected so new clients never show a different target or time.
  target: energyReportTargetSchema.optional(),
  requestedAt: timestampSchema.optional(),
  failure: energyReportFailureSchema.nullable().optional()
}).strict().superRefine((job, context) => {
  if (job.target && (job.target.scope !== job.request.scope || job.target.identityId !== job.request.identityId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "report target must match its request" });
  }
  if (job.requestedAt !== undefined && job.requestedAt !== job.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "requestedAt must equal createdAt" });
  }
  if (job.failure !== undefined && (job.status === "failed"
    ? !job.failure || job.failure.code !== publicReportFailure(job.failureCode ?? "").failure.code
    : job.failure !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "failure must match terminal job state" });
  }
  if (job.status === "queued") {
    if (job.progressPercent !== 0 || job.startedAt !== null || job.completedAt !== null
      || job.expiresAt !== null || job.failureCode !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "queued jobs must not expose processing or file state" });
    }
    return;
  }

  if (job.status === "processing") {
    if (job.progressPercent === 0 || job.progressPercent === 100 || job.startedAt === null
      || job.completedAt !== null || job.expiresAt !== null || job.failureCode !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "processing jobs require in-progress state only" });
    }
    return;
  }

  if (job.status === "completed") {
    if (job.progressPercent !== 100 || job.startedAt === null || job.completedAt === null
      || job.expiresAt === null || job.failureCode !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "completed jobs require completed file state" });
    }
    return;
  }

  if (job.status === "failed") {
    if (job.startedAt === null || job.completedAt !== null || job.expiresAt !== null || job.failureCode === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "failed jobs require a failure code without file state" });
    }
    return;
  }

  if (job.progressPercent !== 100 || job.startedAt === null || job.completedAt === null
    || job.expiresAt === null || job.failureCode !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "expired jobs retain completed file metadata" });
  }
}).transform(job => ({
  ...job,
  target: job.target ?? { scope: job.request.scope, identityId: job.request.identityId,
    label: `${{ site: "현장", fixture: "조명", floor: "층", group: "그룹" }[job.request.scope]}: ${job.request.identityId}` },
  requestedAt: job.createdAt,
  ...(job.failureCode === null ? { failureCode: null, failure: null } : publicReportFailure(job.failureCode))
}));

export const ENERGY_REPORT_PAGE_SIZES = [10, 20, 50, 100] as const;
export type EnergyReportPageSize = typeof ENERGY_REPORT_PAGE_SIZES[number];

const reportPageSizeSchema = z.coerce.number().refine(
  (value): value is EnergyReportPageSize => ENERGY_REPORT_PAGE_SIZES.includes(value as EnergyReportPageSize),
  "invalid report page size"
);

function validateRequestedRange(
  query: { requestedFrom?: string; requestedTo?: string },
  context: z.RefinementCtx
) {
  const { requestedFrom, requestedTo } = query;
  if ((requestedFrom === undefined) !== (requestedTo === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [requestedFrom === undefined ? "requestedFrom" : "requestedTo"],
      message: "requestedFrom and requestedTo must be provided together"
    });
    return;
  }

  if (requestedFrom !== undefined && requestedTo !== undefined) {
    const from = Date.parse(`${requestedFrom}T00:00:00.000Z`);
    const to = Date.parse(`${requestedTo}T00:00:00.000Z`);
    if (from > to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedTo"],
        message: "requestedTo must not end before requestedFrom"
      });
      return;
    }

    const inclusiveDays = Math.floor((to - from) / 86_400_000) + 1;
    if (inclusiveDays > 90) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedTo"],
        message: "requested range must not exceed 90 days"
      });
    }
  }
}

export const energyReportListQuerySchema = z.object({
  limit: reportPageSizeSchema,
  cursor: z.string().min(1).max(1024).optional(),
  query: z.string().trim().min(1).max(100).optional(),
  status: energyReportStatusSchema.optional(),
  format: energyReportFormatSchema.optional(),
  scope: energyScopeSchema.optional(),
  requestedFrom: calendarDateSchema.optional(),
  requestedTo: calendarDateSchema.optional()
}).strict().superRefine(validateRequestedRange);

export const energyReportListResponseSchema = z.object({
  reports: z.array(energyReportJobSchema).max(100),
  nextCursor: z.string().min(1).max(1024).nullable(),
  totalCount: z.number().int().nonnegative()
}).strict();

export const energyReportDownloadResponseSchema = z.object({
  reportId: uuidSchema,
  format: energyReportFormatSchema,
  downloadUrl: z.string().url(),
  expiresInSeconds: z.literal(300)
}).strict();

const reportValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const reportMetadataRowSchema = z.object({
  label: z.string().min(1),
  value: reportValueSchema,
  displayValue: z.string().min(1)
}).strict();

export const reportValueRowSchema = reportMetadataRowSchema;

export const reportColumnSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1)
}).strict();

export const reportCellSchema = z.object({
  value: reportValueSchema,
  displayValue: z.string().min(1)
}).strict();

export const reportHeatmapCellSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  value: z.number().finite().nonnegative().nullable(),
  displayValue: z.string().min(1)
}).strict();

export const energyReportSectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("summary"),
    title: z.string().min(1),
    rows: z.array(reportValueRowSchema)
  }).strict(),
  z.object({
    kind: z.literal("table"),
    id: z.string().min(1),
    title: z.string().min(1),
    columns: z.array(reportColumnSchema).min(1),
    rows: z.array(z.array(reportCellSchema))
  }).strict(),
  z.object({
    kind: z.literal("heatmap"),
    id: z.string().min(1),
    title: z.string().min(1),
    metric: energyHeatmapMetricSchema,
    cells: z.array(reportHeatmapCellSchema).length(168)
  }).strict(),
  z.object({
    kind: z.literal("notes"),
    title: z.string().min(1),
    rows: z.array(z.string().min(1))
  }).strict()
]);

const energyReportDocumentFingerprintInputObjectSchema = z.object({
  schemaVersion: z.literal(1),
  reportId: uuidSchema,
  title: z.string().min(1),
  metadata: z.array(reportMetadataRowSchema),
  sections: z.array(energyReportSectionSchema)
}).strict();

const energyReportDocumentV1FingerprintInputSchema = energyReportDocumentFingerprintInputObjectSchema.superRefine(
  (document, context) => {
    document.sections.forEach((section, sectionIndex) => {
      if (section.kind === "heatmap") {
        validateOrderedHeatmapCells(section.cells, context, ["sections", sectionIndex, "cells"]);
      }
      if (section.kind === "table") {
        section.rows.forEach((row, rowIndex) => {
          if (row.length !== section.columns.length) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["sections", sectionIndex, "rows", rowIndex],
              message: "table rows must contain one cell for each column"
            });
          }
        });
      }
    });
  }
);

const energyReportDocumentV1Schema = energyReportDocumentFingerprintInputObjectSchema.extend({
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/)
}).strict().superRefine((document, context) => {
  document.sections.forEach((section, sectionIndex) => {
    if (section.kind === "heatmap") {
      validateOrderedHeatmapCells(section.cells, context, ["sections", sectionIndex, "cells"]);
    }
    if (section.kind === "table") {
      section.rows.forEach((row, rowIndex) => {
        if (row.length !== section.columns.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sections", sectionIndex, "rows", rowIndex],
            message: "table rows must contain one cell for each column"
          });
        }
      });
    }
  });
});

const reportSourceSchema = z.enum(["persisted_actual", "captured_current_configuration"]);
const calculationGapSchema = z.enum(["dimension_history_missing", "scope_attribution_unavailable"]).nullable();
export const reportCalculationBasisSchema = z.object({
  capturedAt: timestampSchema,
  actualSource: z.literal("persisted_actual"),
  configurationSource: z.literal("captured_current_configuration"),
  tariffKwhRate: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
  expectedSeconds: z.number().finite().nonnegative().nullable(),
  knownSeconds: z.number().finite().nonnegative().nullable(),
  fixtureCount: z.number().int().nonnegative(),
  baselineReason: calculationGapSchema,
  coverageReason: calculationGapSchema
}).strict();

const chartReferences = {
  id: z.string().min(1), tableId: z.string().min(1),
  categoryColumnId: z.string().min(1), valueColumnIds: z.array(z.string().min(1)).min(1),
  rowIds: z.array(z.string().min(1))
};
export const reportVisualizationSchema = z.discriminatedUnion("type", [
  z.object({ ...chartReferences, type: z.literal("daily_actual_vs_baseline"), valueColumnIds: z.array(z.string().min(1)).length(2) }).strict(),
  z.object({ ...chartReferences, type: z.literal("period_comparison"), valueColumnIds: z.array(z.string().min(1)).length(2), rowIds: z.array(z.string().min(1)).length(2) }).strict(),
  z.object({ ...chartReferences, type: z.literal("horizontal_ranking"), valueColumnIds: z.array(z.string().min(1)).length(1), limit: z.literal(10) }).strict(),
  z.object({ id: z.string().min(1), type: z.literal("heatmap"), sectionId: z.string().min(1),
    colorScale: z.literal("sequential"), noData: z.literal("gap"), weekdays: z.literal(7), hours: z.literal(24) }).strict()
]);
const energyReportSectionV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("summary"), title: z.string().min(1), rows: z.array(reportValueRowSchema.extend({ source: reportSourceSchema }).strict()) }).strict(),
  energyReportSectionSchema.options[1].extend({ rowIds: z.array(z.string().min(1)), visualization: reportVisualizationSchema.optional() }).strict(),
  energyReportSectionSchema.options[2].extend({ visualization: reportVisualizationSchema.optional() }).strict(),
  energyReportSectionSchema.options[3]
]);
const energyReportDocumentV2ObjectSchema = energyReportDocumentFingerprintInputObjectSchema.extend({
  schemaVersion: z.literal(2), calculationBasis: reportCalculationBasisSchema,
  sections: z.array(energyReportSectionV2Schema)
}).strict();

function validateV2Document(document: z.infer<typeof energyReportDocumentV2ObjectSchema>, context: z.RefinementCtx) {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  const unique = (values: string[]) => new Set(values).size === values.length;
  const sections = document.sections.filter(section => "id" in section);
  if (!unique(sections.map(section => section.id))) issue("duplicate section id");
  const visualIds: string[] = [];
  for (const [index, section] of document.sections.entries()) {
    if (section.kind === "heatmap") validateOrderedHeatmapCells(section.cells, context, ["sections", index, "cells"]);
    if (section.kind === "table") {
      if (!unique(section.columns.map(column => column.id)) || !unique(section.rowIds)) issue("duplicate table column or row id");
      if (section.rowIds.length !== section.rows.length || section.rows.some(row => row.length !== section.columns.length)) issue("invalid table dimensions");
    }
    if (!("visualization" in section) || !section.visualization) continue;
    const visual = section.visualization;
    visualIds.push(visual.id);
    if (visual.type === "heatmap") {
      if (section.kind !== "heatmap" || visual.sectionId !== section.id) issue("heatmap must reference its own heatmap section");
      continue;
    }
    const table = sections.find(candidate => candidate.id === visual.tableId);
    if (section.kind !== "table" || !table || table.kind !== "table") { issue("visualization table reference does not exist"); continue; }
    const categoryIndex = table.columns.findIndex(column => column.id === visual.categoryColumnId);
    const indexes = visual.valueColumnIds.map(id => table.columns.findIndex(column => column.id === id));
    if (categoryIndex < 0 || indexes.some(index => index < 0)) issue("visualization column reference does not exist");
    if (!unique(visual.rowIds) || !unique(visual.valueColumnIds)) issue("duplicate visualization reference");
    for (const id of visual.rowIds) {
      const row = table.rows[table.rowIds.indexOf(id)];
      if (!row) { issue("visualization row reference does not exist"); continue; }
      if (indexes.some(index => row[index] && row[index].value !== null && typeof row[index].value !== "number")) issue("visualization requires numeric cells or null");
    }
  }
  if (!unique(visualIds)) issue("duplicate visualization id");
  const basis = document.calculationBasis;
  if (basis.knownSeconds !== null && basis.expectedSeconds !== null && basis.knownSeconds > basis.expectedSeconds) issue("known seconds exceed expected seconds");
  if (basis.coverageReason !== null && basis.knownSeconds !== null) issue("unavailable coverage must have null known seconds");
}

// Keep the strict v1 branch untouched: stored documents and their scalar order
// remain valid while v2 adds fingerprinted renderer instructions.
export const energyReportDocumentFingerprintInputSchema = z.union([
  energyReportDocumentV1FingerprintInputSchema, energyReportDocumentV2ObjectSchema.superRefine(validateV2Document)
]);
export const energyReportDocumentSchema = z.union([
  energyReportDocumentV1Schema,
  energyReportDocumentV2ObjectSchema.extend({ contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().superRefine(validateV2Document)
]);
export type ReportVisualization = z.infer<typeof reportVisualizationSchema>;
export type ReportCalculationBasis = z.infer<typeof reportCalculationBasisSchema>;
export type EnergyScope = z.infer<typeof energyScopeSchema>;
export type EnergyHeatmapMetric = z.infer<typeof energyHeatmapMetricSchema>;
export type EnergyHeatmapQuery = z.infer<typeof energyHeatmapQuerySchema>;
export type EnergyHeatmapResponse = z.infer<typeof energyHeatmapResponseSchema>;
export type EnergyHeatmapCell = z.infer<typeof heatmapCellSchema>;
export type EnergyReportFormat = z.infer<typeof energyReportFormatSchema>;
export type EnergyReportStatus = z.infer<typeof energyReportStatusSchema>;
export type EnergyReportListQuery = z.infer<typeof energyReportListQuerySchema>;
export type EnergyReportRequest = z.infer<typeof energyReportRequestSchema>;
export type EnergyReportTargetsResponse = z.infer<typeof energyReportTargetsResponseSchema>;
export type EnergyReportJob = z.infer<typeof energyReportJobSchema>;
export type EnergyReportListResponse = z.infer<typeof energyReportListResponseSchema>;
export type EnergyReportDownloadResponse = z.infer<typeof energyReportDownloadResponseSchema>;
export type ReportMetadataRow = z.infer<typeof reportMetadataRowSchema>;
export type ReportValueRow = z.infer<typeof reportValueRowSchema>;
export type ReportColumn = z.infer<typeof reportColumnSchema>;
export type ReportCell = z.infer<typeof reportCellSchema>;
export type ReportHeatmapCell = z.infer<typeof reportHeatmapCellSchema>;
export type EnergyReportSection = z.infer<typeof energyReportSectionSchema> | z.infer<typeof energyReportSectionV2Schema>;
export type EnergyReportDocumentFingerprintInput = z.infer<typeof energyReportDocumentFingerprintInputSchema>;
export type EnergyReportDocument = z.infer<typeof energyReportDocumentSchema>;
