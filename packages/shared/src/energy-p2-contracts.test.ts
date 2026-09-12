import { describe, expect, it } from "vitest";
import {
  energyHeatmapQuerySchema,
  energyHeatmapResponseSchema,
  energyReportDocumentFingerprintInputSchema,
  energyReportDocumentSchema,
  energyReportDownloadResponseSchema,
  energyReportJobSchema,
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

    expect(energyReportListResponseSchema.parse({ reports: [job] }).reports).toHaveLength(1);
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
