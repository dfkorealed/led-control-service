import ExcelJS from "exceljs";
import JSZip from "jszip";
import { extractExcelReportVisuals } from "./excel-report-xml";
import { ExcelEnergyReportRenderer, extractExcelReportManifest } from "./excel-energy-report.renderer";
import { expectedManifest, forbiddenReportText, longName, reportFixture, visualReportFixture } from "./report-renderer.test-support";

describe("ExcelEnergyReportRenderer", () => {
  it("places all eight charts above raw tables and preserves a hidden visual manifest", async () => {
    const output = await new ExcelEnergyReportRenderer().render(visualReportFixture());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(output.bytes as never);
    expect(workbook.worksheets.flatMap(sheet => sheet.getImages())).toHaveLength(8);
    expect(workbook.getWorksheet("_report_visuals")?.state).toBe("veryHidden");
    for (const sheet of workbook.worksheets) {
      if (!sheet.getImages().length) continue;
      expect(sheet.views[0].state === "frozen" && sheet.views[0].ySplit).toBeLessThanOrEqual(2);
      let firstTableRow = Infinity;
      sheet.eachRow(row => row.eachCell(cell => {
        const note = typeof cell.note === "string" ? cell.note : cell.note?.texts?.map(text => text.text).join("");
        if (note && /\.(columns|cells)\./.test(JSON.parse(note).path)) firstTableRow = Math.min(firstTableRow, row.number);
      }));
      for (const image of sheet.getImages()) {
        const top = image.range.tl.nativeRow;
        const height = (image.range as unknown as ExcelJS.ImagePosition).ext!.height;
        let reservedPixels = 0;
        for (let row = top + 1; row < firstTableRow; row++) reservedPixels += (sheet.getRow(row).height ?? 15) * 96 / 72;
        expect(reservedPixels).toBeGreaterThanOrEqual(height);
      }
    }
  }, 60000);
  it("detects changed archive PNG bytes with an untouched hidden digest manifest", async () => {
    const output = await new ExcelEnergyReportRenderer().render(visualReportFixture());
    const archive = await JSZip.loadAsync(output.bytes);
    const media = Object.values(archive.files).filter(entry => /^xl\/media\/.*\.png$/.test(entry.name));
    archive.file(media[0].name, await media[1].async("nodebuffer"));
    await expect(extractExcelReportVisuals(await archive.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/digest/);
  }, 60000);
  it("preserves CRLF in the actual workbook cells via XML character references", async () => {
    const document = reportFixture();
    document.sections = [];
    document.metadata = [{ label: "줄바꿈", value: "첫째 줄\r\n둘째 줄", displayValue: "첫째 줄\r\n둘째 줄" }];
    const result = await new ExcelEnergyReportRenderer().render(document);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.bytes as never);
    expect(workbook.worksheets[0].getCell("B3").value).toBe("첫째 줄\r\n둘째 줄");
    expect(workbook.worksheets[0].getCell("C3").value).toBe("첫째 줄\r\n둘째 줄");
  });
  it("writes ordered section sheets, real numeric cells, every label/value and safe literal names", async () => {
    const document = reportFixture();
    const output = await new ExcelEnergyReportRenderer().render(document);
    expect(output.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(output.extension).toBe("xlsx");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(output.bytes as never);
    expect(`${workbook.creator} ${workbook.lastModifiedBy}`).not.toMatch(forbiddenReportText);
    expect(workbook.worksheets).toHaveLength(document.sections.length + 1);
    const values: unknown[] = [];
    workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => {
      values.push(cell.value);
      expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
    })));
    expect(values).toEqual(expect.arrayContaining([document.title, document.contentFingerprint, longName, "이름", 12.3456, 0, 0.167, "데이터 없음", false]));
    expect(JSON.stringify(values)).not.toMatch(forbiddenReportText);
    expect(output.manifest).toEqual(expectedManifest(document));
    // Keep path/type notes intact while changing actual cells: extraction must observe damage.
    workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => {
      if (cell.value === 12.3456) cell.value = 99;
      if (cell.value === document.title) cell.value = "제목 손상";
    })));
    const changed = await extractExcelReportManifest(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(changed).toContainEqual({ path: "sections.0.rows.0.value", value: 99 });
    expect(changed).toContainEqual({ path: "title", value: "제목 손상" });
    expect(changed).not.toEqual(output.manifest);
  });
});
