import { describe, expect, it } from "vitest";
import {
  energyHeatmapQuerySchema,
  energyHeatmapResponseSchema,
  energyReportDocumentFingerprintInputSchema,
  energyReportDocumentSchema,
  energyReportDownloadResponseSchema,
  energyReportJobSchema,
  energyReportListQuerySchema,
  energyReportListResponseSchema,
  energyReportRequestSchema,
  energyReportTargetsResponseSchema,
  type EnergyReportDocumentFingerprintInput
} from "./energy-p2-contracts";

const siteId = "00000000-0000-4000-8000-000000000001";
const fixtureId = "00000000-0000-4000-8000-000000000002";
const reportId = "00000000-0000-4000-8000-000000000003";

const heatmapCells = Array.from({ length: 168 }, (_, index) => ({
  weekday: Math.floor(index / 24),
  hour: index % 24,
  value: index === 0 ? 0 : index === 1 ? null : 1.25
}));

const validReportRequest = {
  from: "2026-09-01",
  to: "2026-09-10",
  scope: "fixture" as const,
  identityId: fixtureId,
  format: "xlsx" as const
};

const reportJob = (index: number) => ({
  reportId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
  siteId,
  request: validReportRequest,
  status: "completed" as const,
  progressPercent: 100,
  createdAt: "2026-09-11T00:00:00.000Z",
  startedAt: "2026-09-11T00:00:01.000Z",
  completedAt: "2026-09-11T00:00:05.000Z",
  expiresAt: "2026-09-18T00:00:05.000Z",
  failureCode: null
});

const fingerprintInput: EnergyReportDocumentFingerprintInput = {
  schemaVersion: 1,
  reportId,
  title: "에너지 사용 통계 보고서",
  metadata: [{ label: "현장", value: "본사", displayValue: "본사" }],
  sections: [
    {
      kind: "summary",
      title: "요약",
      rows: [{ label: "사용량", value: 12.5, displayValue: "12.5 kWh" }]
    },
    {
      kind: "table",
      id: "daily-usage",
      title: "일별 사용량",
      columns: [{ id: "date", label: "날짜" }, { id: "energy", label: "사용량" }],
      rows: [[
        { value: "2026-09-01", displayValue: "2026-09-01" },
        { value: 0, displayValue: "0 kWh" }
      ]]
    },
    {
      kind: "heatmap",
      id: "energy-by-hour",
      title: "요일·시간대 사용량",
      metric: "energy",
      cells: heatmapCells.map((cell) => ({
        ...cell,
        displayValue: cell.value === null ? "데이터 없음" : `${cell.value} kWh`
      }))
    },
    { kind: "notes", title: "산정 정보", rows: ["완료된 현지 날짜 집계"] }
  ]
};

describe("energy P2 contracts", () => {
  const v2 = () => ({
    ...fingerprintInput, schemaVersion: 2,
    calculationBasis: { capturedAt: "2026-09-11T00:00:00.000Z", actualSource: "persisted_actual", configurationSource: "captured_current_configuration",
      tariffKwhRate: "160", expectedSeconds: 86400, knownSeconds: 43200, fixtureCount: 1, baselineReason: null, coverageReason: null },
    sections: [
      { kind: "summary", title: "요약", rows: [{ label: "전력량", value: 1, displayValue: "1 kWh", source: "persisted_actual" }] },
      { kind: "table", id: "daily", title: "일별", columns: [{ id: "date", label: "날짜" }, { id: "energy", label: "전력" }, { id: "baseline", label: "기준" }],
        rowIds: ["2026-09-01"], rows: [[{ value: "2026-09-01", displayValue: "2026-09-01" }, { value: null, displayValue: "없음" }, { value: 1, displayValue: "1" }]],
        visualization: { id: "daily-chart", type: "daily_actual_vs_baseline", tableId: "daily", categoryColumnId: "date", valueColumnIds: ["energy", "baseline"], rowIds: ["2026-09-01"] } }
    ]
  });
  it("accepts strict v2 while retaining the unmodified v1 fingerprint payload", () => {
    expect(energyReportDocumentFingerprintInputSchema.parse(fingerprintInput)).toEqual(fingerprintInput);
    expect(energyReportDocumentFingerprintInputSchema.safeParse(v2()).success).toBe(true);
  });
  it.each(["table", "column", "row", "duplicate", "source", "basis", "type", "numeric"])("rejects invalid v2 %s", kind => {
    const document: any = v2();
    const visual = document.sections[1].visualization;
    if (kind === "table") visual.tableId = "missing";
    if (kind === "column") visual.valueColumnIds[0] = "missing";
    if (kind === "row") visual.rowIds[0] = "missing";
    if (kind === "duplicate") document.sections.push({ ...document.sections[1], id: "other" });
    if (kind === "source") document.sections[0].rows[0].source = "unknown";
    if (kind === "basis") delete document.calculationBasis;
    if (kind === "type") visual.type = "pie";
    if (kind === "numeric") document.sections[1].rows[0][1].value = "1";
    expect(energyReportDocumentFingerprintInputSchema.safeParse(document).success).toBe(false);
  });
  it("validates report targets with analytics identities and an explicit completed local date", () => {
    const response = { siteId, timeZone: "Asia/Seoul", lastCompletedDate: "2026-09-11",
      targets: [{ scope: "site", identityId: siteId, label: "현장" }, { scope: "fixture", identityId: fixtureId, label: "조명 💡" }] };
    expect(energyReportTargetsResponseSchema.parse(response)).toEqual(response);
    expect(energyReportTargetsResponseSchema.safeParse({ ...response, lastCompletedDate: "today" }).success).toBe(false);
    expect(energyReportTargetsResponseSchema.safeParse({ ...response, targets: [{ ...response.targets[1], fixtureId }] }).success).toBe(false);
  });
  it("accepts an inclusive heatmap query with one allowed scope and at most 92 days", () => {
    expect(energyHeatmapQuerySchema.parse({
      metric: "brightness",
      from: "2026-06-12",
      to: "2026-09-11",
      scope: "site",
      identityId: siteId
    })).toEqual({
      metric: "brightness",
      from: "2026-06-12",
      to: "2026-09-11",
      scope: "site",
      identityId: siteId
    });
  });

  it("rejects inverted, over-92-day, unsupported-scope, and non-strict heatmap queries", () => {
    expect(energyHeatmapQuerySchema.safeParse({
      metric: "energy", from: "2026-09-11", to: "2026-09-10", scope: "site", identityId: siteId
    }).success).toBe(false);
    expect(energyHeatmapQuerySchema.safeParse({
      metric: "energy", from: "2026-06-11", to: "2026-09-11", scope: "site", identityId: siteId
    }).success).toBe(false);
    expect(energyHeatmapQuerySchema.safeParse({
      metric: "energy", from: "2026-09-01", to: "2026-09-10", scope: "grouping", identityId: siteId
    }).success).toBe(false);
    expect(energyHeatmapQuerySchema.safeParse({
      metric: "energy", from: "2026-09-01", to: "2026-09-10", scope: "site", identityId: siteId, extra: true
    }).success).toBe(false);
  });

  it("accepts exactly 168 ordered heatmap cells and preserves actual zero separately from missing data", () => {
    const result = energyHeatmapResponseSchema.parse({
      siteId,
      timeZone: "Asia/Seoul",
      generatedAt: "2026-09-11T00:00:00.000Z",
      metric: "energy",
      scope: "fixture",
      identityId: fixtureId,
      range: { from: "2026-09-01", to: "2026-09-10" },
      cells: heatmapCells
    });

    expect(result.cells).toHaveLength(168);
    expect(result.cells[0].value).toBe(0);
    expect(result.cells[1].value).toBeNull();
  });

  it("rejects incomplete, duplicate, out-of-order, and non-strict heatmap cells", () => {
    const validHeatmap = {
      siteId,
      timeZone: "Asia/Seoul",
      generatedAt: "2026-09-11T00:00:00.000Z",
      metric: "brightness",
      scope: "site",
      identityId: siteId,
      range: { from: "2026-09-01", to: "2026-09-10" },
      cells: heatmapCells
    };
    expect(energyHeatmapResponseSchema.safeParse({ ...validHeatmap, cells: heatmapCells.slice(1) }).success).toBe(false);
    expect(energyHeatmapResponseSchema.safeParse({
      ...validHeatmap,
      cells: [{ ...heatmapCells[0], weekday: 1 }, ...heatmapCells.slice(1)]
    }).success).toBe(false);
    expect(energyHeatmapResponseSchema.safeParse({
      ...validHeatmap,
      cells: [heatmapCells[1], heatmapCells[0], ...heatmapCells.slice(2)]
    }).success).toBe(false);
    expect(energyHeatmapResponseSchema.safeParse({ ...validHeatmap, unexpected: true }).success).toBe(false);
  });

  it("rejects non-finite heatmap response values", () => {
    expect(energyHeatmapResponseSchema.safeParse({
      siteId,
      timeZone: "Asia/Seoul",
      generatedAt: "2026-09-11T00:00:00.000Z",
      metric: "energy",
      scope: "site",
      identityId: siteId,
      range: { from: "2026-09-01", to: "2026-09-10" },
      cells: [{ ...heatmapCells[0], value: Infinity }, ...heatmapCells.slice(1)]
    }).success).toBe(false);
  });

  it("accepts a report request with only its fixed range, scope, identity, and format", () => {
    expect(energyReportRequestSchema.parse(validReportRequest)).toEqual(validReportRequest);
    expect(energyReportRequestSchema.safeParse({ ...validReportRequest, sections: ["summary"] }).success).toBe(false);
    expect(energyReportRequestSchema.safeParse({ ...validReportRequest, format: "csv" }).success).toBe(false);
    expect(energyReportRequestSchema.safeParse({ ...validReportRequest, scope: "carbon" }).success).toBe(false);
  });

  it("normalizes legacy job metadata and validates additive target/time/failure fields strictly", () => {
    const legacy = { reportId, siteId, request: validReportRequest, status: "queued", progressPercent: 0,
      createdAt: "2026-09-11T00:00:00.000Z", startedAt: null, completedAt: null, expiresAt: null, failureCode: null };
    expect(energyReportJobSchema.parse(legacy)).toMatchObject({
      target: { scope: "fixture", identityId: validReportRequest.identityId, label: `조명: ${validReportRequest.identityId}` },
      requestedAt: legacy.createdAt, failure: null
    });
    const metadata = { ...legacy, target: { scope: "fixture", identityId: validReportRequest.identityId, label: "요청 당시 조명" },
      requestedAt: legacy.createdAt, failure: null };
    expect(energyReportJobSchema.safeParse(metadata).success).toBe(true);
    for (const invalid of [
      { target: { ...metadata.target, identityId: reportId } },
      { target: { ...metadata.target, scope: "floor" } },
      { target: { ...metadata.target, label: "" } },
      { target: { ...metadata.target, internalId: "private" } },
      { requestedAt: "2026-09-12T00:00:00.000Z" },
      { failure: { code: "generation_failed", message: "실패", action: "재시도" } },
      { rawError: "private" }
    ]) expect(energyReportJobSchema.safeParse({ ...metadata, ...invalid }).success).toBe(false);
  });

  it.each([
    ["REPORT_GENERATION_FAILED", "generation_failed"], ["REPORT_STORAGE_UNAVAILABLE", "storage_unavailable"],
    ["REPORT_RENDERING_FAILED", "rendering_failed"], ["REPORT_SNAPSHOT_INVALID", "snapshot_invalid"],
    ["REPORT_ATTEMPTS_EXHAUSTED", "attempts_exhausted"], ["private database://password", "generation_failed"]
  ])("maps legacy failure %s to a safe actionable failure", (failureCode, code) => {
    const legacy = { reportId, siteId, request: validReportRequest, status: "failed", progressPercent: 0,
      createdAt: "2026-09-11T00:00:00.000Z", startedAt: "2026-09-11T00:00:01.000Z",
      completedAt: null, expiresAt: null, failureCode };
    const result = energyReportJobSchema.parse(legacy);
    expect(result).toMatchObject({ failure: { code, message: expect.any(String), action: expect.any(String) } });
    expect(JSON.stringify(result)).not.toContain("password");
    for (const failure of [null, { code: "internal", message: "실패", action: "재시도" },
      { code, message: "실패", action: "재시도", stack: "private" }]) {
      expect(energyReportJobSchema.safeParse({ ...legacy, failure }).success).toBe(false);
    }
  });

  it.each([10, 20, 50, 100])("accepts report page size %i", (limit) => {
    expect(energyReportListQuerySchema.parse({ limit })).toEqual({ limit });
  });

  it.each([0, 1, 19, 21, 101])("rejects report page size %i", (limit) => {
    expect(() => energyReportListQuerySchema.parse({ limit })).toThrow();
  });

  it("normalizes report filters", () => {
    expect(energyReportListQuerySchema.parse({
      limit: 20,
      query: "  서울 물류센터  ",
      status: "completed",
      format: "pdf",
      scope: "site",
      requestedFrom: "2026-09-01",
      requestedTo: "2026-09-16"
    })).toEqual({
      limit: 20,
      query: "서울 물류센터",
      status: "completed",
      format: "pdf",
      scope: "site",
      requestedFrom: "2026-09-01",
      requestedTo: "2026-09-16"
    });
  });

  it("rejects incomplete, inverted, and over-90-day report date ranges", () => {
    for (const invalid of [
      { limit: 20, requestedFrom: "2026-09-01" },
      { limit: 20, requestedTo: "2026-09-16" },
      { limit: 20, requestedFrom: "2026-09-16", requestedTo: "2026-09-01" },
      { limit: 20, requestedFrom: "2026-06-01", requestedTo: "2026-09-01" }
    ]) expect(energyReportListQuerySchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts at most 100 reports with cursor and total", () => {
    expect(energyReportListResponseSchema.parse({
      reports: Array.from({ length: 100 }, (_, index) => reportJob(index)),
      nextCursor: "opaque",
      totalCount: 137
    }).totalCount).toBe(137);
  });

  it("rejects unknown and out-of-bounds query fields", () => {
    expect(energyReportListQuerySchema.safeParse({ limit: 20, unexpected: true }).success).toBe(false);
    expect(energyReportListQuerySchema.safeParse({ limit: 20, query: "a".repeat(101) }).success).toBe(false);
    expect(energyReportListQuerySchema.safeParse({ limit: 20, cursor: "" }).success).toBe(false);
    expect(energyReportListQuerySchema.safeParse({ limit: 20, cursor: "c".repeat(1025) }).success).toBe(false);
  });

  it("rejects oversized and malformed report list response metadata", () => {
    expect(energyReportListResponseSchema.safeParse({
      reports: Array.from({ length: 101 }, (_, index) => reportJob(index)),
      nextCursor: null,
      totalCount: 101
    }).success).toBe(false);
    expect(energyReportListResponseSchema.safeParse({ reports: [], nextCursor: "", totalCount: 0 }).success).toBe(false);
    expect(energyReportListResponseSchema.safeParse({ reports: [], nextCursor: "c".repeat(1025), totalCount: 0 }).success).toBe(false);
    expect(energyReportListResponseSchema.safeParse({ reports: [], nextCursor: null, totalCount: -1 }).success).toBe(false);
    expect(energyReportListResponseSchema.safeParse({ reports: [], nextCursor: null, totalCount: 1.5 }).success).toBe(false);
    expect(energyReportListResponseSchema.safeParse({ reports: [], nextCursor: null, totalCount: 0, unexpected: true }).success).toBe(false);
  });

  it("accepts status-safe report job, list, and five-minute download responses", () => {
    const job = energyReportJobSchema.parse({
      reportId,
      siteId,
      request: validReportRequest,
      status: "completed",
      progressPercent: 100,
      createdAt: "2026-09-11T00:00:00.000Z",
      startedAt: "2026-09-11T00:00:01.000Z",
      completedAt: "2026-09-11T00:00:05.000Z",
      expiresAt: "2026-09-18T00:00:05.000Z",
      failureCode: null
    });

    expect(energyReportListResponseSchema.parse({ reports: [job], nextCursor: null, totalCount: 1 }).reports).toHaveLength(1);
    expect(energyReportDownloadResponseSchema.parse({
      reportId,
      format: "xlsx",
      downloadUrl: "https://storage.example.test/download/report.xlsx",
      expiresInSeconds: 300
    }).expiresInSeconds).toBe(300);
  });

  it("rejects report job states and downloads that expose unavailable file data", () => {
    const completedJob = {
      reportId,
      siteId,
      request: validReportRequest,
      status: "completed",
      progressPercent: 100,
      createdAt: "2026-09-11T00:00:00.000Z",
      startedAt: "2026-09-11T00:00:01.000Z",
      completedAt: "2026-09-11T00:00:05.000Z",
      expiresAt: "2026-09-18T00:00:05.000Z",
      failureCode: null
    };
    expect(energyReportJobSchema.safeParse({ ...completedJob, progressPercent: 99 }).success).toBe(false);
    expect(energyReportJobSchema.safeParse({ ...completedJob, status: "failed", failureCode: null }).success).toBe(false);
    expect(energyReportDownloadResponseSchema.safeParse({
      reportId, format: "pdf", downloadUrl: "https://storage.example.test/download/report.pdf", expiresInSeconds: 301
    }).success).toBe(false);
  });

  it("keeps the immutable document fingerprint input free of renderer-only and prohibited report fields", () => {
    expect(energyReportDocumentFingerprintInputSchema.parse(fingerprintInput)).toEqual(fingerprintInput);
    expect(energyReportDocumentSchema.parse({
      ...fingerprintInput,
      contentFingerprint: "a".repeat(64)
    }).contentFingerprint).toHaveLength(64);
    expect(energyReportDocumentFingerprintInputSchema.safeParse({
      ...fingerprintInput,
      contentFingerprint: "a".repeat(64)
    }).success).toBe(false);
    expect(energyReportDocumentSchema.safeParse({
      ...fingerprintInput,
      contentFingerprint: "a".repeat(64),
      baselineKwh: 24
    }).success).toBe(false);
    expect(energyReportDocumentSchema.safeParse({
      ...fingerprintInput,
      contentFingerprint: "a".repeat(64),
      sections: [{ ...fingerprintInput.sections[0], rows: [{ label: "사용량", value: 1, displayValue: "1 kWh", coverageRate: 1 }] }]
    }).success).toBe(false);
  });

  it("rejects non-finite values in fingerprinted document metadata and heatmap cells", () => {
    expect(energyReportDocumentSchema.safeParse({
      ...fingerprintInput,
      metadata: [{ label: "현장", value: Infinity, displayValue: "본사" }],
      contentFingerprint: "a".repeat(64)
    }).success).toBe(false);
    expect(energyReportDocumentSchema.safeParse({
      ...fingerprintInput,
      sections: [{
        ...fingerprintInput.sections[2],
        cells: [{ ...fingerprintInput.sections[2].cells[0], value: Infinity }, ...fingerprintInput.sections[2].cells.slice(1)]
      }],
      contentFingerprint: "a".repeat(64)
    }).success).toBe(false);
  });
});
