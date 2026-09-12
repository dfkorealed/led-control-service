# Task 5 implementation report

## Implementation

- Added a reusable `EnergyReportRenderer` contract returning `bytes`, `contentType`, `extension`, and a manifest extracted from serialized output.
- `reportBlocks` is the common ordered traversal of the strict immutable `EnergyReportDocument`. It retains schema/report identifiers, title, every metadata field, all section kinds/IDs/titles/columns/rows, all 168 heatmap coordinates and raw/display values, notes, and `contentFingerprint`. No database reads, data aggregation, relabeling, or new report calculations occur.
- ExcelJS writes an initial document sheet and one sheet per ordered section. Untruncated titles stay in cells; sheet names are ordinal layout identifiers. Raw numeric and boolean values remain their native cell types. Formula-looking strings remain literal strings. Raw null is explicitly serialized as `null` beside the document's display value.
- pdf-lib/fontkit writes A4 pages with measured character wrapping, synchronized column continuation for oversized rows, and whole-row page breaks for rows that fit on a page. Heatmap cells are arranged in six-hour blocks, retaining weekday/hour/raw/display order. Section and column IDs remain visible, rather than being silently dropped from the document.
- XLSX extraction reads actual serialized cells through path/type notes. PDF extraction decodes actual marked `Tj` page text using embedded-font `ToUnicode` maps. Structural mappings contain paths/types only, never input values. Each renderer verifies the extracted manifest against its traversal and fails on missing or changed content.
- Tests independently walk the fixture's schema leaves. They also mutate serialized XLSX labels/numbers and remove PDF title/numeric text operators while keeping mappings unchanged, demonstrating that the extraction is not an input-echo tautology.
- Added repository-controlled Korean Regular/Bold font assets and OFL license. Nest copies them to `dist/src/assets/fonts`, matching the compiled renderer's relative path. Updated the statistics menu implementation/remaining-work documentation.

## TDD evidence

1. Initial RED: all three renderer suites failed against empty-output stubs. XLSX/PDF content types were empty and the contract manifest was `[]` instead of the independently derived 899 ordered tokens.
2. GREEN: implemented XLSX/PDF output, actual-byte extraction, common traversal, and manifest verification. The original three tests passed.
3. Metadata RED: opening generated XLSX showed `Unknown Unknown` in ExcelJS's default author metadata, violating the forbidden-word requirement. GREEN: set creator/lastModifiedBy from the document title.
4. Compiled runtime RED: the initial Nest default asset path produced `ENOENT .../dist/src/assets/fonts/NotoSansKR-Regular.ttf`. GREEN: explicitly copy assets under `dist/src`; the compiled renderer produced both real files.
5. Visual/font RED: Poppler exposed missing Korean/Latin/numeric glyphs despite correct ToUnicode extraction. An embedded-glyph-outline regression failed with `RangeError: Trying to access beyond buffer length`. GREEN: embed intact static fonts, preserve all Unicode characters while removing optional OpenType layout substitutions from the repository font assets, and validate drawable embedded glyph outlines. This also avoids uncoded contextual alternate glyphs that cannot be faithfully extracted via cmap.
6. Pagination RED: a short table row/heatmap cell's coordinate/raw/display tokens appeared on two pages (`Expected: 1; Received: 2`). GREEN: move a row to the next page when the whole row fits a page; only oversized rows split.

## Verification

- Focused command: `pnpm --filter @led-control/api exec jest src/energy/reports --runInBand`.
- Typecheck: `pnpm --filter @led-control/api typecheck`.
- Build: `pnpm --filter @led-control/api build`.
- Full API regression: `pnpm --filter @led-control/api test -- --runInBand`.
- Compiled smoke: require `apps/api/dist/src/energy/reports/*renderer.js`, render the strict shared fixture, save temporary binary files, and compare each returned manifest with all 899 source leaves.
- Visual QA: render the compiled PDF with `pdftoppm -scale-to 1100 -png`; inspect every resulting A4 page, including long Korean metadata/ranking names and all heatmap continuation pages.
- `git diff --check`.
- Final results: focused reports **5 suites / 21 tests passed**; API typecheck/build exited **0**; full API **107 suites / 970 tests passed**, **22 suites / 205 opt-in tests skipped**; no failed suites. Final full regression took 15.456 seconds.
- Compiled smoke produced a **5,869,621-byte PDF with 899 extracted tokens** and a **42,363-byte XLSX with the same 899 tokens**. All ten PDF pages were inspected; the final table and heatmap page breaks keep ordinary rows/cells intact and Korean/Latin/numeric text remains legible without clipping.
- Final `git diff --check` exited **0**. PDF/XLSX fixtures and page PNGs are temporary QA artifacts under `/tmp/led-report-qa`, not repository deliverables.

## Font provenance and reproducibility

- Authoritative source: [Google Fonts Noto Sans KR](https://github.com/google/fonts/blob/b38c5c93af322c45f633e17ac440ec1e6c94d489/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf), pinned commit `b38c5c93af322c45f633e17ac440ec1e6c94d489`.
- [SIL OFL 1.1 license](https://github.com/google/fonts/blob/b38c5c93af322c45f633e17ac440ec1e6c94d489/ofl/notosanskr/OFL.txt) wording is retained in the repository; one upstream trailing space is removed for `git diff --check`.
- Derived using fonttools 4.61.1: instantiate at weight 400/700 with `--update-name-table`, then retain `--unicodes='*'`, all name metadata, and `--layout-features=''`. Exact commands are in `apps/api/src/assets/fonts/README.md`.
- Source variable TTF SHA-256: `194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252`.
- Committed Regular SHA-256: `9b2429cf680dee8bc02c811020b3eabcec9a3ad572d81c670318d92b700c72d0`.
- Committed Bold SHA-256: `7909d4432a9015a90e13750858f8a2c865a99c2d8caf09b50fef2242d3c2fbcf`.

## Files

- `apps/api/src/energy/reports/report-renderer.ts`
- `apps/api/src/energy/reports/excel-energy-report.renderer.ts`
- `apps/api/src/energy/reports/pdf-energy-report.renderer.ts`
- `apps/api/src/energy/reports/pdf-report-manifest.ts`
- `apps/api/src/energy/reports/report-renderer.contract.spec.ts`
- `apps/api/src/energy/reports/excel-energy-report.renderer.spec.ts`
- `apps/api/src/energy/reports/pdf-energy-report.renderer.spec.ts`
- `apps/api/src/energy/reports/report-renderer.test-support.ts`
- `apps/api/src/assets/fonts/{NotoSansKR-Regular.ttf,NotoSansKR-Bold.ttf,OFL.txt,README.md}`
- `apps/api/package.json`, `apps/api/nest-cli.json`, `pnpm-lock.yaml`
- `docs/menus/statistics.md`
- This report.

## Self-review and concerns

- No P2-C/carbon/optimization content, production Chromium, database/schema changes, or endpoint/worker additions.
- Rendering content is validated after serialization. Tests catch omitted labels/values, lost numeric XLSX typing, formula injection, missing font outlines, changed cell/text content, ordering loss, empty raw strings, empty sections, and short-row splits.
- The PDF retains complete Korean fonts for dependable glyph rendering. The representative 10-page fixture is approximately 5.9 MB; this is an explicit size tradeoff over the broken fontkit subset path. Further size reduction needs a separately verified font pipeline.
- Font assets keep all Unicode characters from upstream, but optional ligature/context substitution features are removed for reliable scalar extraction. Reports are optimized for Korean/Latin content; scripts requiring shaping are not a supported typography contract here.
- Heatmap layout prioritizes readable coordinates/raw/display values on A4 by using consecutive six-hour blocks. It does not introduce derived color-scale numbers, legends, or renamed weekday labels.
- Renderers are reusable providers but are intentionally not registered in the job worker/module yet; Task 6 owns job processing/storage/download integration.
- No external database or hardware validation was claimed. Existing opt-in integration suites remain skipped when their environment is absent.

## Fix Round 1

### Findings and implementation

1. PDF extraction previously rebuilt manifest order from `ReportTokenMap`, so moving physical pages could leave the extracted result unchanged. `pdf-report-order.ts` now derives physical blocks from page order and drawn text coordinates, verifies top-to-bottom block order and left-to-right group order, and preserves observed token order. Only groups inside the same oversized row can interleave across page boundaries. Each drawn text fragment carries a monotonically increasing fragment ordinal; reordered continuations are rejected as well. The returned manifest is assembled from these verified physical occurrences, not by walking the token map. Structural mapping metadata contains only paths/types/block/group identifiers.
2. XML newline normalization and PDF's LF-only wrapping lost carriage returns from schema-valid strings. XLSX now escapes literal XML carriage returns as `&#13;` before final serialization, using the repository's existing JSZip 3.10.2 version as an explicit dependency. PDF wrapping recognizes CRLF/CR/LF, and line-break markers retain the exact spelling of these non-glyph separators. Immutable document values and fingerprints are never normalized or modified.

### RED / GREEN

- Initial RED command: `pnpm --filter @led-control/api exec jest src/energy/reports/report-renderer.contract.spec.ts src/energy/reports/pdf-energy-report.renderer.spec.ts --runInBand`.
  - **2 suites failed; 3 tests failed, 3 passed.** Both CRLF renderer cases threw `Generated report content does not match the immutable document`. The page permutation assertion failed because extraction resolved to the original manifest instead of rejecting.
- CRLF GREEN command: `pnpm --filter @led-control/api exec jest src/energy/reports/report-renderer.contract.spec.ts src/energy/reports/excel-energy-report.renderer.spec.ts --runInBand`.
  - **2 suites / 6 tests passed.** The individual Excel test reopens generated workbook cells B3/C3 and verifies exact `첫째 줄\r\n둘째 줄` content.
- Combined GREEN command: `pnpm --filter @led-control/api exec jest src/energy/reports/report-renderer.contract.spec.ts src/energy/reports/pdf-energy-report.renderer.spec.ts src/energy/reports/excel-energy-report.renderer.spec.ts --runInBand`.
  - **3 suites / 8 tests passed.** PDF regression swaps serialized pages 4/5, swaps two actual row positions while keeping mapping metadata intact, and accepts a correctly wrapped oversized row spanning pages. Cross-format tests assert the original document is unchanged.

### Verification and self-review

- Reports: `pnpm --filter @led-control/api exec jest src/energy/reports --runInBand` — **5 suites / 25 tests passed**, final run 10.611 seconds.
- Full API: `pnpm --filter @led-control/api test -- --runInBand` — **107 suites / 974 tests passed**, **22 suites / 205 opt-in tests skipped**; no failed suites, final run 19.819 seconds.
- `pnpm --filter @led-control/api typecheck` and `pnpm --filter @led-control/api build` — exit **0**.
- Compiled smoke loads the actual `dist/src/energy/reports` renderers/extractor, appends CRLF metadata to the 899-token fixture, independently checks both manifests against all **902** document leaves, verifies unchanged input, and confirms serialized page permutation rejects with an order error. Final output: `pdf 5872001 902`, `xlsx 42458 902`, `CRLF preserved; page permutation rejected`.
- `git diff --check` — exit **0**. Temporary smoke files are under `/tmp/led-report-fix1-5KOVTO`; the first page is rendered with `pdftoppm -f 1 -singlefile -scale-to 1100 -png` to inspect the CRLF text visually.
- Added `excel-report-xml.ts` and `pdf-report-order.ts`, updated the individual/contract regressions, and refreshed `docs/menus/statistics.md` in this fix.
- Existing PDF font/size tradeoffs remain unchanged. Ordering extraction supports the renderer's explicit row/column continuation layout, not arbitrary third-party PDF layouts. Both Important findings are addressed; no new feature scope or subagents were introduced.

Exact compiled smoke command, executed from the worktree root after the final build:

```sh
node -e 'const assert=require("node:assert/strict");const base="./apps/api/dist/src/energy/reports/";const {PdfEnergyReportRenderer}=require(base+"pdf-energy-report.renderer.js");const {ExcelEnergyReportRenderer}=require(base+"excel-energy-report.renderer.js");const {extractPdfReportManifest}=require(base+"pdf-report-manifest.js");const {reportFixture,expectedManifest}=require(base+"report-renderer.test-support.js");const {PDFDocument}=require("./apps/api/node_modules/pdf-lib");(async()=>{const document=reportFixture();document.metadata.push({label:"줄바꿈",value:"첫째 줄\r\n둘째 줄",displayValue:"첫째 줄\r\n둘째 줄"});const original=structuredClone(document);const results=await Promise.all([new PdfEnergyReportRenderer().render(document),new ExcelEnergyReportRenderer().render(document)]);for(const result of results){assert.deepEqual(result.manifest,expectedManifest(document));console.log(result.extension,result.bytes.length,result.manifest.length);}assert.deepEqual(document,original);const pdf=await PDFDocument.load(results[0].bytes);const page=pdf.getPage(3);pdf.removePage(3);pdf.insertPage(4,page);await assert.rejects(extractPdfReportManifest(await pdf.save()),/order/i);console.log("CRLF preserved; page permutation rejected")})().catch(error=>{console.error(error);process.exitCode=1})'
```
