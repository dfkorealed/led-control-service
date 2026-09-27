import type { EnergyReportDocument } from "@led-control/shared";
import { Injectable } from "@nestjs/common";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, PDFHexString, PDFName, beginMarkedContent, endMarkedContent, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { extractPdfReportManifest } from "./pdf-report-manifest";
import { buildPdfReportPresentation } from "./pdf-report-presentation";
import { ENERGY_PDF_PAGE as P, hasPdfAmount, pdfDisplayFacts } from "./report-pdf-layout";
import { reportFontRuns } from "./report-text";
import type { EnergyReportRenderer, RenderedEnergyReport, ReportManifest } from "./report-renderer";

const color = {
  navy: rgb(0.08, 0.18, 0.27), blue: rgb(0.12, 0.42, 0.64), pale: rgb(0.91, 0.96, 0.98),
  light: rgb(0.95, 0.97, 0.98), border: rgb(0.79, 0.87, 0.92), muted: rgb(0.38, 0.49, 0.58),
  prior: rgb(0.58, 0.70, 0.76), white: rgb(1, 1, 1)
};
const weekdays = ["일", "월", "화", "수", "목", "금", "토"];

export function expectedPdfReportManifest(document: EnergyReportDocument): ReportManifest {
  return pdfDisplayFacts(buildPdfReportPresentation(document));
}
export function verifyPdfReportManifest(document: EnergyReportDocument, actual: ReportManifest): void {
  if (JSON.stringify(actual) !== JSON.stringify(expectedPdfReportManifest(document)))
    throw new Error("Generated PDF display differs from the immutable report snapshot");
}

@Injectable()
export class PdfEnergyReportRenderer implements EnergyReportRenderer {
  async render(document: EnergyReportDocument): Promise<RenderedEnergyReport & { visuals: [] }> {
    const model = buildPdfReportPresentation(document);
    const facts = pdfDisplayFacts(model);
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const files = ["NotoSansKR-Regular.ttf", "NotoSansKR-Bold.ttf", "NotoEmoji.ttf"];
    const fonts = await Promise.all(files.map(async (name, index) => {
      const bytes = await readFile(join(__dirname, "../../assets/fonts", name));
      // Bundled fontkit can produce invalid Noto Korean subsets with default
      // feature substitution, so embed intact fonts with features disabled.
      const features = Object.fromEntries(fontkit.create(bytes).availableFeatures.map(feature => [feature, false]));
      return pdf.embedFont(bytes, { subset: false, features, customName: name.slice(0, -4) });
    }));
    pdf.catalog.set(PDFName.of("ReportDisplayMap"), PDFHexString.fromText(JSON.stringify(facts.map(entry => entry.path))));
    let page!: PDFPage;
    let pageNo = 0;
    let factNo = 0;
    const textBoxes = new Map<number, Array<{ x: number; y: number; w: number; h: number }>>();
    const fontFor = (run: { index: number }, bold: boolean): PDFFont => fonts[run.index === 1 ? 2 : bold ? 1 : 0];
    const measure = (value: string, size: number, bold = false) => reportFontRuns(value).reduce((w, run) =>
      w + fontFor(run, bold).widthOfTextAtSize(run.text, size), 0);
    const wrap = (value: string, size: number, maxWidth: number, bold = false) => {
      const result: string[] = [];
      let line = "";
      for (const char of value) {
        if (char === "\n") { result.push(line); line = ""; continue; }
        if (line && measure(line + char, size, bold) > maxWidth) { result.push(line); line = ""; }
        line += char;
      }
      result.push(line);
      return result;
    };
    const writeLine = (value: string, x: number, y: number, size: number, bold = false, ink = color.navy) => {
      const w = measure(value, size, bold);
      if (x < P.margin - 0.001 || x + w > P.width - P.margin + 0.001 || y < P.bottom || y + size > P.top)
        throw new Error(`PDF text exceeds page bounds: ${value.slice(0, 30)}`);
      const box = { x, y: y - 1, w, h: size + 1 };
      const occupied = textBoxes.get(pageNo)!;
      if (w && occupied.some(other => box.x < other.x + other.w - 0.4 && box.x + box.w > other.x + 0.4 &&
        box.y < other.y + other.h - 0.4 && box.y + box.h > other.y + 0.4))
        throw new Error(`PDF text overlaps: ${value.slice(0, 30)}`);
      occupied.push(box);
      let advance = x;
      for (const run of reportFontRuns(value)) {
        const font = fontFor(run, bold);
        page.drawText(run.text, { x: advance, y, size, font, color: ink });
        advance += font.widthOfTextAtSize(run.text, size);
      }
    };
    const write = (value: string, x: number, y: number, size: number, maxWidth: number, bold = false,
      ink = color.navy, leading = size + 5) => {
      for (const part of wrap(value, size, maxWidth, bold)) { writeLine(part, x, y, size, bold, ink); y -= leading; }
      return y;
    };
    const fact = (path: string, x: number, y: number, size: number, maxWidth: number, bold = false,
      ink = color.navy, leading = size + 5) => {
      const entry = facts[factNo];
      if (entry?.path !== path) throw new Error(`PDF fact order mismatch: ${path} / ${entry?.path}`);
      const index = factNo++;
      wrap(String(entry.value), size, maxWidth, bold).forEach((part, fragment) => {
        page.pushOperators(beginMarkedContent(`D${index}S${fragment}`));
        writeLine(part, x, y, size, bold, ink);
        page.pushOperators(endMarkedContent());
        y -= leading;
      });
      return y;
    };
    const box = (x: number, y: number, w: number, h: number, fill = color.white, stroke = color.border) =>
      page.drawRectangle({ x, y, width: w, height: h, color: fill, borderColor: stroke, borderWidth: 0.7 });
    const newPage = (title: string) => {
      page = pdf.addPage([P.width, P.height]); pageNo++;
      textBoxes.set(pageNo, []);
      write("KINDA / ENERGY REPORT", P.margin, 789, 8, 320, true, color.blue);
      page.drawLine({ start: { x: P.margin, y: 777 }, end: { x: P.width - P.margin, y: 777 }, thickness: 0.7, color: color.border });
      write(title, P.margin, 744, 18, 507, true);
    };
    const bar = (x: number, y: number, w: number, h: number, ratio: number, fill = color.blue) => {
      box(x, y, w, h, color.light, color.light);
      if (ratio > 0) box(x, y, Math.max(1, w * Math.min(1, ratio)), h, fill, fill);
    };

    newPage("조명 에너지 사용 보고서");
    let introY = fact("site", P.margin, 710, 10, 500);
    introY = fact("scope", P.margin, introY - 1, 9, 500, false, color.muted);
    introY = fact("period", P.margin, introY - 1, 9, 500, false, color.muted);
    const qualityY = Math.min(655, introY - 52);
    box(P.margin, qualityY, 507, 51, color.pale, color.pale);
    write("자료 확인", P.margin + 15, qualityY + 32, 10, 470, true, color.blue);
    fact("quality.current", P.margin + 15, qualityY + 14, 9, 470);
    const kpiTop = qualityY - 27;
    write("핵심 결과", P.margin, kpiTop, 12, 480, true);
    const cards = [
      ["이번 기간 사용량", "summary.current", P.margin, kpiTop - 119],
      ["직전 동일 일수 사용량", "summary.previous", P.margin + 260, kpiTop - 119],
      ["기록 사용량 차이", "summary.difference", P.margin, kpiTop - 219],
      ["이번 기간 저장 비용", "summary.storedCost", P.margin + 260, kpiTop - 219]
    ] as const;
    for (const [label, path, x, y] of cards) {
      box(x, y, 247, 89, color.light, color.light);
      write(label, x + 14, y + 65, 9, 215, false, color.muted);
      fact(path, x + 14, y + 33, 15, 215, true);
    }
    const comparisonTop = kpiTop - 235;
    const comparisonHeight = model.summary.comparisonAvailable ? 127 : 98;
    box(P.margin, comparisonTop - comparisonHeight, 507, comparisonHeight);
    write("직전 동일 일수와 비교", P.margin + 15, comparisonTop - 21, 11, 470, true);
    if (model.summary.comparisonAvailable) {
      const current = Number(model.summary.current.raw ?? 0), previous = Number(model.summary.previous.raw ?? 0);
      const max = Math.max(1, current, previous);
      write("직전 기간", P.margin + 16, comparisonTop - 59, 9, 90);
      bar(P.margin + 116, comparisonTop - 61, 310, 14, previous / max, color.prior);
      write("이번 기간", P.margin + 16, comparisonTop - 99, 9, 90);
      bar(P.margin + 116, comparisonTop - 101, 310, 14, current / max);
    } else write(model.summary.comparisonReason ?? "수집 기록이 완전하지 않아 비교할 수 없습니다.",
      P.margin + 16, comparisonTop - 66, 10, 470, false, color.muted);

    newPage("기간별 사용 추이");
    box(P.margin, 308, 507, 404);
    write("일별 사용량", P.margin + 15, 687, 11, 430, true);
    write("단위 kWh", 490, 687, 8, 58, false, color.muted);
    if (model.daily.some(row => row.completeness !== "complete"))
      fact("trend.note", 92, 650, 8, 425, false, color.muted);
    const plot = { x: 92, y: 365, w: 425, h: 268 };
    // A persisted amount from a partial or uncertain day is not a full-day
    // measurement. Keep it in the detail table, but never connect it as a trend point.
    const values = model.daily.map(row => row.completeness !== "complete" || row.energy.raw === null ? null : Number(row.energy.raw));
    const maxDaily = Math.max(1, ...values.filter((value): value is number => value !== null));
    for (let tick = 0; tick <= 3; tick++) {
      const ty = plot.y + tick * plot.h / 3;
      page.drawLine({ start: { x: plot.x, y: ty }, end: { x: plot.x + plot.w, y: ty }, thickness: 0.6, color: color.border });
      write((maxDaily * tick / 3).toFixed(model.precision), 56, ty - 3, 7, 30, false, color.muted);
    }
    let previousPoint: { x: number; y: number } | null = null;
    values.forEach((value, index) => {
      if (value === null) { previousPoint = null; return; }
      const point = { x: plot.x + index * plot.w / Math.max(1, values.length - 1), y: plot.y + value / maxDaily * plot.h };
      if (previousPoint) page.drawLine({ start: previousPoint, end: point, thickness: 1.3, color: color.blue });
      // Preserve endpoints beside missing/uncertain spans even when the normal
      // 12-point decimation would hide an isolated complete day entirely.
      const gapBoundary = values[index - 1] === null || values[index + 1] === null;
      if (index === 0 || index === values.length - 1 || gapBoundary || index % Math.max(1, Math.ceil(values.length / 12)) === 0)
        page.drawCircle({ x: point.x, y: point.y, size: 1.7, color: color.blue });
      previousPoint = point;
    });
    if (!values.some(value => value !== null)) write(model.daily.some(row => row.energy.raw !== null)
      ? "완전한 기록 없음" : "데이터 없음", 278, 495, 12, 130, true, color.muted);
    write(model.period.from.slice(5), plot.x, 339, 8, 80, false, color.muted);
    write(model.period.to.slice(5), 476, 339, 8, 65, false, color.muted);
    if (model.peakDay) {
      write("최고 기록일", P.margin + 15, 324, 8, 88, false, color.muted);
      fact("peakDay.date", P.margin + 103, 324, 8, 93, true);
      fact("peakDay.energy", P.margin + 205, 324, 8, 290, true);
    }
    for (let offset = 0; offset < model.monthly.length; offset += 6) {
      if (offset) newPage("월별 사용량 (계속)");
      const rows = model.monthly.slice(offset, offset + 6);
      const top = offset ? 712 : 292;
      const height = 65 + rows.length * 23;
      box(P.margin, top - height, 507, height);
      write("월별 사용량", P.margin + 15, top - 23, 11, 470, true);
      let monthlyY = top - 52;
      rows.forEach((_, index) => {
        const monthIndex = offset + index;
        fact(`monthly.${monthIndex}.month`, P.margin + 15, monthlyY, 9, 92, true);
        fact(`monthly.${monthIndex}.energy`, P.margin + 155, monthlyY, 9, 160);
        fact(`monthly.${monthIndex}.cost`, P.margin + 380, monthlyY, 9, 110);
        monthlyY -= 23;
      });
    }

    if (model.floors.rows.length || model.fixtures.topFive.length || hasPdfAmount(model.floors.unassigned) || hasPdfAmount(model.fixtures.unassigned)) {
      newPage("어디에서 사용했나");
      const floorRowHeights = model.floors.rows.map(row => Math.max(35,
        wrap(row.name, 9, 105, true).length * 14 + 8,
        wrap(row.energy.text, 9, 100, true).length * 14 + 8));
      const floorMax = Math.max(1, ...model.floors.rows.map(row => Number(row.energy.raw ?? 0)));
      let floorIndex = 0, floorTop = 712, floorBottom = floorTop;
      do {
        const start = floorIndex;
        let rowsHeight = 0;
        // Reserve the unassigned row only on the final floor page. Every
        // continuation repeats the heading; the source fact order stays intact.
        while (floorIndex < floorRowHeights.length) {
          const next = floorIndex + 1;
          const tailHeight = next === floorRowHeights.length && hasPdfAmount(model.floors.unassigned) ? 25 : 0;
          if (floorTop - (67 + rowsHeight + floorRowHeights[floorIndex] + tailHeight) < 85) break;
          rowsHeight += floorRowHeights[floorIndex++];
        }
        if (floorIndex === start && floorIndex < floorRowHeights.length)
          throw new Error("Single floor ranking row exceeds PDF page capacity");
        const lastFloorPage = floorIndex === floorRowHeights.length;
        const floorHeight = 67 + rowsHeight + (lastFloorPage && hasPdfAmount(model.floors.unassigned) ? 25 : 0);
        floorBottom = floorTop - floorHeight;
        box(P.margin, floorBottom, 507, floorHeight);
        page.pushOperators(beginMarkedContent("FloorHeading"));
        write(start ? "층별 사용량 (계속)" : "층별 사용량", P.margin + 15, floorTop - 26, 11, 470, true);
        page.pushOperators(endMarkedContent());
        let floorY = floorTop - 64;
        for (let index = start; index < floorIndex; index++) {
          const row = model.floors.rows[index];
          fact(`floors.${index}.name`, P.margin + 16, floorY, 9, 105, true);
          bar(P.margin + 150, floorY - 2, 230, 13, Number(row.energy.raw ?? 0) / floorMax);
          fact(`floors.${index}.energy`, P.margin + 390, floorY, 9, 100, true);
          floorY -= floorRowHeights[index];
        }
        if (lastFloorPage && hasPdfAmount(model.floors.unassigned)) {
          write("귀속 불가", P.margin + 16, floorY, 9, 120);
          fact("floors.unassigned", P.margin + 390, floorY, 9, 100, true);
        }
        if (!lastFloorPage) { newPage("어디에서 사용했나 (계속)"); floorTop = 712; }
      } while (floorIndex < floorRowHeights.length);
      const fixtureRowHeights = model.fixtures.topFive.map(row => Math.max(35,
        wrap(row.name, 8, 180).length * 11 + 8,
        wrap(row.energy.text, 8, 100).length * 13 + 8));
      const fixtureHeight = 55 + fixtureRowHeights.reduce((sum, height) => sum + height, 0) +
        (hasPdfAmount(model.fixtures.other) ? 23 : 0) + (hasPdfAmount(model.fixtures.unassigned) ? 23 : 0) + 10;
      let fixtureTop = floorBottom - 16;
      if (fixtureTop - fixtureHeight < 85) { newPage("조명 사용량"); fixtureTop = 712; }
      if (fixtureTop - fixtureHeight < 85) throw new Error("Fixture ranking exceeds PDF page capacity");
      box(P.margin, fixtureTop - fixtureHeight, 507, fixtureHeight);
      write("사용량 상위 5개 조명", P.margin + 15, fixtureTop - 26, 11, 470, true);
      const fixtureMax = Math.max(1, ...model.fixtures.topFive.map(row => Number(row.energy.raw ?? 0)));
      let fixtureY = fixtureTop - 59;
      model.fixtures.topFive.forEach((row, index) => {
        fact(`fixtures.${index}.name`, P.margin + 15, fixtureY, 8, 180, false, color.navy, 11);
        bar(P.margin + 205, fixtureY - 2, 175, 10, Number(row.energy.raw ?? 0) / fixtureMax);
        fact(`fixtures.${index}.energy`, P.margin + 390, fixtureY, 8, 100);
        fixtureY -= fixtureRowHeights[index];
      });
      if (hasPdfAmount(model.fixtures.other)) {
        write("그 외 조명", P.margin + 15, fixtureY, 9, 170);
        fact("fixtures.other", P.margin + 390, fixtureY, 9, 100, true);
        fixtureY -= 22;
      }
      if (hasPdfAmount(model.fixtures.unassigned)) {
        write("귀속 불가", P.margin + 15, fixtureY, 9, 170);
        fact("fixtures.unassigned", P.margin + 390, fixtureY, 9, 100, true);
      }
    }

    newPage("언제 사용했나");
    box(P.margin, 457, 507, 255);
    write("요일·시간별 누적 전력량", P.margin + 15, 686, 11, 420, true);
    write("단위 kWh", 490, 686, 8, 58, false, color.muted);
    const cellSize = 18.1, cellX = 104, cellTop = 626;
    const maxCell = Math.max(0, ...model.heatmap.map(entry => Number(entry.energy.raw ?? 0)));
    for (let hour = 0; hour < 24; hour += 3)
      write(String(hour).padStart(2, "0"), cellX + hour * cellSize, 647, 7, 18, false, color.muted);
    weekdays.forEach((day, weekday) => write(day, 73, cellTop - weekday * cellSize + 6, 8, 14, true));
    model.heatmap.forEach((entry, index) => {
      const value = entry.energy.raw === null ? null : Number(entry.energy.raw);
      const intensity = value === null || entry.completeness !== "complete" ? -1 : maxCell === 0 ? 0 : value / maxCell;
      const fill = intensity < 0 ? color.light : intensity < 0.1 ? color.pale : intensity < 0.3 ? rgb(0.79, 0.90, 0.96) :
        intensity < 0.55 ? rgb(0.59, 0.81, 0.92) : intensity < 0.8 ? rgb(0.35, 0.68, 0.84) : color.blue;
      page.pushOperators(beginMarkedContent(`HeatCell${index}`));
      box(cellX + entry.hour * cellSize, cellTop - entry.weekday * cellSize, cellSize - 2.5, cellSize - 2.5, fill, fill);
      page.pushOperators(endMarkedContent());
    });
    write("적음", 78, 482, 8, 35, false, color.muted);
    [color.pale, rgb(0.79, 0.90, 0.96), rgb(0.59, 0.81, 0.92), rgb(0.35, 0.68, 0.84), color.blue]
      .forEach((fill, index) => box(120 + index * 24, 479, 21, 11, fill, fill));
    write("많음", 252, 482, 8, 35, false, color.muted);
    write("자료 상태", 345, 482, 8, 65, false, color.muted);
    fact("heatmap.coverage", 413, 482, 8, 130, true);
    const peakTop = 438;
    const peakHeight = 64 + (model.peakCell ? 24 : 0) + model.dominantHours.length * 18;
    box(P.margin, peakTop - peakHeight, 507, peakHeight, color.pale, color.pale);
    write("시간대 주요 수치", P.margin + 15, peakTop - 25, 10, 470, true, color.blue);
    if (model.peakCell) fact("heatmap.peak", P.margin + 15, peakTop - 52, 9, 470, true);
    let hourY = peakTop - 76;
    model.dominantHours.forEach((_, index) => { fact(`heatmap.hour.${index}`, P.margin + 15, hourY, 8, 470); hourY -= 18; });
    const formulaTop = peakTop - peakHeight - 18;
    const formulaText = String(facts.find(entry => entry.path === "document.formula")!.value);
    const noteText = String(facts.find(entry => entry.path === "quality.note")?.value ?? "");
    const formulaHeight = 84 + (wrap(formulaText, 8, 470).length - 1) * 12 +
      (noteText ? wrap(noteText, 8, 470).length * 12 + 2 : 0);
    box(P.margin, formulaTop - formulaHeight, 507, formulaHeight);
    write("산식 및 문서 정보", P.margin + 15, formulaTop - 25, 10, 470, true);
    let infoY = fact("document.formula", P.margin + 15, formulaTop - 50, 8, 470, false, color.navy, 12) - 3;
    if (model.quality.notes.length) infoY = fact("quality.note", P.margin + 15, infoY, 8, 470, false, color.muted, 12) - 2;
    infoY = fact("timeZone", P.margin + 15, infoY, 8, 470, false, color.muted);
    fact("capturedAt", P.margin + 15, infoY, 8, 470, false, color.muted);

    let dailyIndex = 0;
    for (const month of model.monthly) {
      newPage(`${month.month} 일별 상세`);
      let rowY = 690;
      const header = () => {
        box(P.margin, rowY - 12, 507, 27, color.pale, color.pale);
        write("날짜", P.margin + 13, rowY, 8, 108, true);
        write("사용량", P.margin + 154, rowY, 8, 125, true);
        write("저장 비용", P.margin + 307, rowY, 8, 130, true);
        write("자료", P.margin + 443, rowY, 8, 49, true);
        rowY -= 34;
      };
      header();
      for (const row of month.days) {
        if (rowY < 78) { newPage(`${month.month} 일별 상세 (계속)`); rowY = 690; header(); }
        const fill = dailyIndex % 2 ? color.white : color.light;
        box(P.margin, rowY - 10, 507, 23, fill, fill);
        fact(`daily.${dailyIndex}.date`, P.margin + 13, rowY, 8, 127);
        fact(`daily.${dailyIndex}.energy`, P.margin + 154, rowY, 8, 141);
        fact(`daily.${dailyIndex}.cost`, P.margin + 307, rowY, 8, 124);
        fact(`daily.${dailyIndex}.status`, P.margin + 443, rowY, 8, 51, false,
          row.completeness === "complete" ? color.muted : color.blue);
        dailyIndex++; rowY -= 19;
      }
    }
    if (factNo !== facts.length) throw new Error(`PDF facts omitted: ${facts.slice(factNo).map(f => f.path).join(", ")}`);
    pdf.getPages().forEach((current, index) => {
      page = current; pageNo = index + 1;
      page.drawLine({ start: { x: P.margin, y: 68 }, end: { x: P.width - P.margin, y: 68 }, thickness: 0.7, color: color.border });
      write(`${index + 1} / ${pdf.getPageCount()}`, 514, 52, 7, 37, false, color.muted);
    });
    const bytes = Buffer.from(await pdf.save());
    const manifest = await extractPdfReportManifest(bytes);
    verifyPdfReportManifest(document, manifest);
    return { bytes, manifest, visuals: [], contentType: "application/pdf", extension: "pdf" };
  }
}
