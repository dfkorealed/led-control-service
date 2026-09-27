import type { ReportBlock } from "./report-renderer";
import { reportTextWidth } from "./report-text";
import type { EnergyReportDocument } from "@led-control/shared";
import { createHash } from "node:crypto";
import { buildReportVisuals } from "./report-visual-model";
import { REPORT_CHART_SIZE, renderReportVisual, validateReportVisualPng, type RenderedReportVisual } from "./report-chart-image.renderer";
import type { PdfReportPresentation } from "./pdf-report-presentation";
import type { ReportManifest } from "./report-renderer";

export const ENERGY_PDF_PAGE = { width: 595.28, height: 841.89, margin: 44, top: 798, bottom: 44 } as const;
export const hasPdfAmount = (measure: { raw: string | null }) => measure.raw !== null && measure.raw !== "0";
function qualitySummary(notes: string[]): string {
  const selected = [notes[0]];
  const hourly = notes.find(note => note.startsWith("요일·시간별 전력량:"));
  if (hourly && hourly !== notes[0]) selected.push(hourly);
  const rest = notes.length - selected.length;
  return `${selected.join(" / ")}${rest ? ` 외 ${rest}건. 날짜별 자료 상태는 일별 상세를 확인하세요.` : ""}`;
}
function localCaptureTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

/** One entry per visible fact. This list is built independently of drawing so
 * the worker can compare the serialized PDF glyphs with the snapshot. */
export function pdfDisplayFacts(p: PdfReportPresentation): ReportManifest {
  const facts: ReportManifest = [];
  const add = (path: string, value: string) => facts.push({ path, value });
  add("site", p.site);
  if (p.target !== p.site) add("target", p.target);
  add("period", `${p.period.from} ~ ${p.period.to}`);
  add("quality.current", `${p.quality.current.completeDays}/${p.quality.current.totalDays}일`);
  add("summary.current", p.summary.current.text);
  add("summary.previous", p.summary.comparisonAvailable ? p.summary.previous.text : "비교 불가");
  add("summary.difference", p.summary.comparisonAvailable ? p.summary.difference.text : "비교 불가");
  add("summary.storedCost", p.summary.storedCost.text);
  if (p.peakDay) { add("peakDay.date", p.peakDay.date); add("peakDay.energy", p.peakDay.energy.text); }
  p.monthly.forEach((month, index) => {
    add(`monthly.${index}.month`, month.month);
    add(`monthly.${index}.energy`, month.energy.text);
    add(`monthly.${index}.cost`, month.cost.text);
  });
  p.floors.rows.forEach((row, index) => { add(`floors.${index}.name`, row.name); add(`floors.${index}.energy`, row.energy.text); });
  if (hasPdfAmount(p.floors.unassigned)) add("floors.unassigned", p.floors.unassigned.text);
  p.fixtures.topFive.forEach((row, index) => { add(`fixtures.${index}.name`, row.name); add(`fixtures.${index}.energy`, row.energy.text); });
  if (hasPdfAmount(p.fixtures.other)) add("fixtures.other", p.fixtures.other.text);
  if (hasPdfAmount(p.fixtures.unassigned)) add("fixtures.unassigned", p.fixtures.unassigned.text);
  add("heatmap.coverage", ({ complete: "완전", partial: "부분 기록", missing: "기록 없음", unknown: "확인 불가" } as const)[p.heatmapCoverage ?? "unknown"]);
  if (p.peakCell) add("heatmap.peak", `${["일", "월", "화", "수", "목", "금", "토"][p.peakCell.weekday]}요일 ${String(p.peakCell.hour).padStart(2, "0")}:00 ${p.peakCell.energy.text}`);
  p.dominantHours.forEach((hour, index) => add(`heatmap.hour.${index}`, `${String(hour.hour).padStart(2, "0")}:00 ${hour.energy.text}`));
  add("document.formula", "차이 = 이번 기간 - 직전 동일 일수. 저장 비용은 당시 저장된 값입니다. 기록상의 차이는 검증된 절감량이 아닙니다.");
  if (p.quality.notes.length) add("quality.note", qualitySummary(p.quality.notes));
  add("timeZone", p.timeZone);
  add("capturedAt", localCaptureTime(p.capturedAt, p.timeZone));
  p.daily.forEach((row, index) => {
    add(`daily.${index}.date`, row.date);
    add(`daily.${index}.energy`, row.energy.text);
    add(`daily.${index}.cost`, row.cost.text);
    add(`daily.${index}.status`, row.completeness === "complete" ? "완전" : row.completeness === "missing" ? "기록 없음" : row.completeness === "partial" ? "부분 기록" : "확인 불가");
  });
  return facts;
}

export type ReportVisualManifest = Array<{ id: string; sha256: string; width: number; height: number }>;

/** Shared source preparation accepts worker-rendered bytes without re-encoding.
 * Standalone renderers retain the same deterministic default for existing callers. */
export async function prepareReportVisuals(document: EnergyReportDocument, supplied?: RenderedReportVisual[]) {
  const descriptors = buildReportVisuals(document);
  const images = supplied ?? await Promise.all(descriptors.map(renderReportVisual));
  if (images.length !== descriptors.length) throw new Error("Missing report chart images");
  return Promise.all(descriptors.map(async (descriptor, index) => {
    const image = images[index];
    await validateReportVisualPng(image.png);
    if (image.id !== descriptor.id || image.sha256 !== createHash("sha256").update(image.png).digest("hex") ||
      image.width !== REPORT_CHART_SIZE.width || image.height !== REPORT_CHART_SIZE.height || image.altText !== descriptor.altText) throw new Error("Invalid report chart source");
    const section = document.schemaVersion === 2 ? document.sections.findIndex(section => {
      if (!("visualization" in section) || !section.visualization) return false;
      const visual = section.visualization;
      return visual.id === image.id || (visual.type === "period_comparison" && visual.valueColumnIds.some(column => `${visual.id}/${column}` === image.id));
    }) : -1;
    if (section < 0) throw new Error("Missing report chart section");
    return { ...image, section, title: descriptor.title };
  }));
}

export function visualManifest(images: Array<{ id: string; sha256: string; width: number; height: number }>): ReportVisualManifest {
  return images.map(({ id, sha256, width, height }) => ({ id, sha256, width, height }));
}

export function verifyVisualManifest(expected: ReportVisualManifest, actual: ReportVisualManifest): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Generated report chart images do not match their sources");
}

export function reportPdfChartSize(width: number, height: number) {
  const scale = Math.min((REPORT_PDF_PAGE.width - REPORT_PDF_PAGE.margin * 2) / width, 330 / height);
  return { width: width * scale, height: height * scale };
}

/** Generated chart axes use en dashes whose glyph aliases cannot round-trip in
 * Noto's ToUnicode map. Captions use an equivalent ASCII range; scalars and PNG
 * bytes remain untouched, and Korean caption text remains real selectable text. */
export function reportPdfCaption(text: string): string { return text.replace(/–/g, "-"); }

export const REPORT_PDF_PAGE = { width: 595.28, height: 841.89, margin: 36, top: 798, bottom: 44 };

export function reportPdfLayout(block: ReportBlock) {
  return {
    isBold: block.style === "title" || block.style === "columns",
    size: block.style === "title" ? 18 : block.style === "detail" || block.style === "heatmap" ? 8 : 9,
    lineHeight: block.style === "title" ? 26 : 14,
    groupWidth: (REPORT_PDF_PAGE.width - REPORT_PDF_PAGE.margin * 2) / block.groups.length
  };
}

/** Share physical line boundaries with acceptance checks: wrapping can change shaping. */
export function wrapReportText(text: string, isBold: boolean, size: number, width: number) {
  const result: Array<{ text: string; lineBreak: number }> = [];
  const paragraphs = text.split(/(\r\n|\r|\n)/);
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 2) {
    let line = "";
    // A line break has no glyph; the PDF marker retains its exact CR/LF spelling.
    let lineBreak = ["", "\n", "\r", "\r\n"].indexOf(paragraphs[paragraphIndex - 1] ?? "");
    for (const character of paragraphs[paragraphIndex]) {
      if (line && reportTextWidth(line + character, isBold, size) > width) {
        result.push({ text: line, lineBreak }); line = ""; lineBreak = 0;
      }
      line += character;
    }
    result.push({ text: line, lineBreak });
  }
  return result;
}
