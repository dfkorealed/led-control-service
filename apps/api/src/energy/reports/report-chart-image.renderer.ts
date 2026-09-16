import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import sharp from "sharp";
import { REPORT_PALETTE as palette, type ReportVisual } from "./report-visual-model";

export const REPORT_CHART_SIZE = { width: 1000, height: 560 } as const;
export const REPORT_CHART_MAX_BYTES = 4 * 1024 * 1024;
export type RenderedReportVisual = { id: string; png: Buffer; width: number; height: number; sha256: string; altText: string };
const plot = { left: 110, top: 130, width: 830, height: 330 };
// Stored heatmaps use JavaScript getUTCDay(): Sunday is index zero.
const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
let fonts: Array<ReturnType<typeof fontkit.create>> | undefined;
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
const number = (value: number) => {
  if (!Number.isFinite(value)) throw new Error("Non-finite report chart geometry");
  return String(Math.round(value * 1000) / 1000);
};
function color(value: string): string {
  const allowed: readonly string[] = [...Object.values(palette).filter((entry): entry is Exclude<typeof entry, readonly string[]> => typeof entry === "string"), ...palette.heat];
  if (!allowed.includes(value)) throw new Error("Unsupported report chart color");
  return value;
}

/** Glyph paths use our bundled fonts, avoiding librsvg/fontconfig host fallback.
 * Full labels remain in escaped accessibility attributes even when fitted to a
 * bounded visual width. Neither SVG CSS nor external font resources are used. */
function text(value: string, x: number, y: number, size = 16, maxWidth = 800, anchor: "start" | "middle" | "end" = "start"): string {
  fonts ??= ["NotoSansKR-Regular.ttf", "NotoEmoji.ttf"].map(name => fontkit.create(readFileSync(join(__dirname, "../../assets/fonts", name))));
  let advance = 0;
  const paths: string[] = [];
  const runs: Array<{ index: number; text: string }> = [];
  for (const character of value.replace(/[\r\n]/g, " ")) {
    const index = fonts.findIndex(font => font.hasGlyphForCodePoint(character.codePointAt(0)!));
    if (index < 0) throw new Error("Unsupported report chart character");
    const previous = runs.at(-1);
    if (previous?.index === index) previous.text += character;
    else runs.push({ index, text: character });
  }
  // Images need drawable glyphs, not PDF cmap round-trip uniqueness. For example
  // en dash shares an outline with another code point in the bundled font; its
  // original code point remains intact in the escaped accessible label.
  for (const run of runs) {
    const font = fonts[run.index];
    const scale = size / font.unitsPerEm;
    const features = Object.fromEntries(font.availableFeatures.map(feature => [feature, false]));
    const layout = font.layout(run.text, features);
    layout.glyphs.forEach((glyph, index) => {
      const position = layout.positions[index];
      paths.push(`<path d="${escape(glyph.path.toSVG())}" transform="translate(${number(advance + position.xOffset * scale)} ${number(-position.yOffset * scale)}) scale(${number(scale)} ${number(-scale)})"/>`);
      advance += position.xAdvance * scale;
    });
  }
  const fit = Math.min(1, maxWidth / Math.max(1, advance));
  const offset = anchor === "middle" ? advance * fit / 2 : anchor === "end" ? advance * fit : 0;
  return `<g aria-label="${escape(value)}" fill="${palette.text}" transform="translate(${number(x - offset)} ${number(y)}) scale(${number(fit)} 1)">${paths.join("")}</g>`;
}
const rect = (x: number, y: number, width: number, height: number, fill: string, attributes = "") => `<rect ${attributes}x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" fill="${escape(fill)}"/>`;
const line = (x1: number, y1: number, x2: number, y2: number, stroke: string) => `<line x1="${number(x1)}" y1="${number(y1)}" x2="${number(x2)}" y2="${number(y2)}" stroke="${escape(stroke)}"/>`;
function scaleFor(values: Array<number | null>) {
  let min = 0, max = 0;
  values.forEach(value => { if (value !== null) { if (!Number.isFinite(value)) throw new Error("Invalid chart value"); min = Math.min(min, value); max = Math.max(max, value); } });
  if (min === max) max = min + 1;
  // Normalize first so finite extreme inputs do not overflow max - min.
  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  const ratio = (value: number) => (value / magnitude - min / magnitude) / (max / magnitude - min / magnitude);
  return { min, max, ratio, ticks: Array.from({ length: 5 }, (_, index) => min * (1 - index / 4) + max * index / 4) };
}
const tickLabel = (value: number) => value === 0 ? "0" : Math.abs(value) >= 100000 || Math.abs(value) < 0.001 ? value.toExponential(2) : String(Number(value.toFixed(3)));

function cartesian(visual: Extract<ReportVisual, { kind: "line" | "bar" }>): string {
  const categories = visual.kind === "line" ? visual.x : visual.categories;
  const scale = scaleFor(visual.series.flatMap(series => series.values));
  const y = (value: number) => plot.top + plot.height * (1 - scale.ratio(value));
  const x = (index: number) => plot.left + (index + 0.5) * plot.width / Math.max(1, categories.length);
  const pieces: string[] = [];
  scale.ticks.forEach(tick => { pieces.push(line(plot.left, y(tick), plot.left + plot.width, y(tick), palette.grid), text(tickLabel(tick), plot.left - 10, y(tick) + 5, 13, 85, "end")); });
  pieces.push(line(plot.left, y(0), plot.left + plot.width, y(0), palette.text));
  const stride = Math.max(1, Math.ceil(categories.length / 8));
  categories.forEach((label, index) => { if (index % stride === 0 || index === categories.length - 1) pieces.push(text(label, x(index), 486, 13, 94, "middle")); });
  // Baseline bars render behind actual lines, regardless of descriptor order.
  const barCount = Math.max(1, visual.series.filter(series => series.style === "bar").length);
  let barIndex = 0;
  for (const series of visual.series) {
    if (series.values.length !== categories.length || series.displayValues.length !== categories.length) throw new Error("Invalid chart dimensions");
    if (series.style !== "bar") continue;
    const width = Math.min(64, plot.width / Math.max(1, categories.length) * 0.7) / barCount;
    series.values.forEach((value, index) => {
      if (value === null) { pieces.push(text(visual.noData.label, x(index), y(0) - 5, 11, 72, "middle")); return; }
      pieces.push(`<g aria-label="${escape(`${categories[index]}: ${series.displayValues[index]}`)}">${rect(x(index) - width * barCount / 2 + barIndex * width, Math.min(y(value), y(0)), width, Math.max(1, Math.abs(y(0) - y(value))), color(series.color))}</g>`);
    });
    barIndex++;
  }
  visual.series.forEach((series, seriesIndex) => {
    if (series.style !== "line") return;
    let segment: string[] = [];
    const flush = () => { if (segment.length > 1) pieces.push(`<polyline data-line-segment="${seriesIndex}" points="${escape(segment.join(" "))}" fill="none" stroke="${color(series.color)}" stroke-width="3"/>`); segment = []; };
    series.values.forEach((value, index) => {
      if (value === null) { flush(); return; }
      segment.push(`${number(x(index))},${number(y(value))}`);
      pieces.push(`<circle data-series-point="${seriesIndex}:${index}" cx="${number(x(index))}" cy="${number(y(value))}" r="4" fill="${color(series.color)}" aria-label="${escape(`${categories[index]}: ${series.displayValues[index]}`)}"/>`);
    });
    flush();
  });
  if (!categories.length) pieces.push(text(visual.noData.label, 500, 280, 20, 300, "middle"));
  return pieces.join("");
}

function ranking(visual: Extract<ReportVisual, { kind: "horizontal-bar" }>): string {
  if (!visual.rows.length) return text(visual.noData.label, 500, 280, 20, 400, "middle");
  if (visual.rows.length > 10) throw new Error("Ranking exceeds ten rows");
  const scale = scaleFor(visual.rows.map(row => row.value));
  const x = (value: number) => 290 + scale.ratio(value) * 510;
  return scale.ticks.map(tick => line(x(tick), 125, x(tick), 465, palette.grid) + text(tickLabel(tick), x(tick), 488, 12, 85, "middle")).join("") +
    visual.rows.map((row, index) => {
      const y = 136 + index * 32;
      return text(row.label, 274, y + 17, 14, 240, "end") +
        (row.value === null ? rect(290, y, 510, 22, "url(#no-data)") : rect(Math.min(x(0), x(row.value)), y, Math.max(1, Math.abs(x(row.value) - x(0))), 22, palette.actual)) +
        text(row.displayValue, 817, y + 17, 13, 160);
    }).join("");
}

function heatmap(visual: Extract<ReportVisual, { kind: "heatmap" }>): string {
  if (visual.cells.length !== 168) throw new Error("Invalid heatmap dimensions");
  const max = Math.max(0, ...visual.cells.map(cell => cell.value ?? 0));
  const pieces: string[] = [];
  for (let hour = 0; hour < 24; hour++) pieces.push(text(String(hour), 116 + hour * 35, 123, 12, 32, "middle"));
  weekdays.forEach((day, index) => pieces.push(text(day, 78, 168 + index * 45, 16, 45, "middle")));
  visual.cells.forEach((cell, index) => {
    if (cell.weekday !== Math.floor(index / 24) || cell.hour !== index % 24 || (cell.value !== null && (!Number.isFinite(cell.value) || cell.value < 0))) throw new Error("Invalid heatmap cell");
    const fill = cell.value === null ? "url(#no-data)" : palette.heat[max === 0 ? 0 : Math.min(4, Math.floor(cell.value / max * 4))];
    pieces.push(rect(100 + cell.hour * 35, 139 + cell.weekday * 45, 33, 43, fill,
      `data-heatmap-cell="${cell.weekday}:${cell.hour}" `).replace("/>", ` aria-label="${escape(`${weekdays[cell.weekday]} ${cell.hour}시: ${cell.displayValue}`)}"/>`));
  });
  pieces.push(text("낮음", 625, 485, 13, 50));
  palette.heat.forEach((fill, index) => pieces.push(rect(665 + index * 34, 471, 34, 16, fill)));
  pieces.push(text("높음", 845, 485, 13, 50));
  return pieces.join("");
}

/** The only SVG construction entrypoint; every dynamic string is XML-escaped. */
export function renderReportVisualSvg(visual: ReportVisual): string {
  const { width, height } = REPORT_CHART_SIZE;
  const legend = visual.legend.map((entry, index) => rect(40 + index * 330, 73, 18, 12, color(entry.color)) + text(entry.label, 66 + index * 330, 86, 14, 292)).join("");
  const chart = visual.kind === "heatmap" ? heatmap(visual) : visual.kind === "horizontal-bar" ? ranking(visual) : cartesian(visual);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Noto Sans KR" role="img" aria-label="${escape(visual.altText)}"><title>${escape(visual.title)}</title><desc>${escape(visual.altText)}</desc><defs><pattern id="no-data" width="8" height="8" patternUnits="userSpaceOnUse">${rect(0, 0, 8, 8, palette.noData)}<path d="M-2 2 L2 -2 M0 8 L8 0 M6 10 L10 6" stroke="${palette.noDataStroke}" stroke-width="1"/></pattern></defs>${rect(0, 0, width, height, palette.background)}${text(visual.title, 40, 44, 25, 920)}${legend}${text(visual.axes.y, 40, 111, 13, 870)}${chart}${text(visual.axes.x, 500, 516, 14, 740, "middle")}${rect(40, 530, 18, 14, "url(#no-data)")}${text(visual.noData.label, 65, 543, 12, 350)}</svg>`;
}

/** Decode after encoding: a plausible header alone does not prove a valid PNG. */
export async function validateReportVisualPng(png: Buffer): Promise<void> {
  if (!png.length || png.length > REPORT_CHART_MAX_BYTES) throw new Error("Report chart PNG exceeds size limit");
  const decoder = sharp(png, { limitInputPixels: REPORT_CHART_SIZE.width * REPORT_CHART_SIZE.height, failOn: "warning" });
  const metadata = await decoder.metadata();
  if (metadata.format !== "png" || metadata.width !== REPORT_CHART_SIZE.width || metadata.height !== REPORT_CHART_SIZE.height || (metadata.pages ?? 1) !== 1) throw new Error("Invalid report chart PNG dimensions");
  const decoded = await decoder.raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== REPORT_CHART_SIZE.width || decoded.info.height !== REPORT_CHART_SIZE.height) throw new Error("Invalid decoded report chart dimensions");
}

export async function renderReportVisual(visual: ReportVisual): Promise<RenderedReportVisual> {
  const png = await sharp(Buffer.from(renderReportVisualSvg(visual)), { density: 72, limitInputPixels: REPORT_CHART_SIZE.width * REPORT_CHART_SIZE.height })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
  await validateReportVisualPng(png);
  return { id: visual.id, png, ...REPORT_CHART_SIZE, sha256: createHash("sha256").update(png).digest("hex"), altText: visual.altText };
}
