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
export const energyReportFormatSchema = z.enum(["xlsx", "pdf"]);
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

/** Fixture/group IDs are analytics identities, never operational device/group IDs. */
export const energyReportTargetsResponseSchema = z.object({
  siteId: uuidSchema,
  timeZone: z.string().min(1),
  lastCompletedDate: calendarDateSchema,
  targets: z.array(z.object({ scope: energyScopeSchema, identityId: uuidSchema, label: z.string().min(1) }).strict())
}).strict();

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
  failureCode: z.string().min(1).nullable()
}).strict().superRefine((job, context) => {
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
});

export const energyReportListResponseSchema = z.object({
  reports: z.array(energyReportJobSchema).max(50)
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

export const energyReportDocumentFingerprintInputSchema = energyReportDocumentFingerprintInputObjectSchema.superRefine(
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

export const energyReportDocumentSchema = energyReportDocumentFingerprintInputObjectSchema.extend({
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

export type EnergyScope = z.infer<typeof energyScopeSchema>;
export type EnergyHeatmapMetric = z.infer<typeof energyHeatmapMetricSchema>;
export type EnergyHeatmapQuery = z.infer<typeof energyHeatmapQuerySchema>;
export type EnergyHeatmapResponse = z.infer<typeof energyHeatmapResponseSchema>;
export type EnergyHeatmapCell = z.infer<typeof heatmapCellSchema>;
export type EnergyReportFormat = z.infer<typeof energyReportFormatSchema>;
export type EnergyReportStatus = z.infer<typeof energyReportStatusSchema>;
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
export type EnergyReportSection = z.infer<typeof energyReportSectionSchema>;
export type EnergyReportDocumentFingerprintInput = z.infer<typeof energyReportDocumentFingerprintInputSchema>;
export type EnergyReportDocument = z.infer<typeof energyReportDocumentSchema>;
