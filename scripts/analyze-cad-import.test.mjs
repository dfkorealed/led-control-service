import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const analyzer = path.join(root, "scripts/analyze-cad-import.mjs");

const SAMPLE_DXF = `999
test fixture
0
SECTION
2
HEADER
9
$ACADVER
1
AC1027
9
$DWGCODEPAGE
3
ANSI_1252
0
ENDSEC
0
SECTION
2
BLOCKS
0
BLOCK
2
LED_FIXTURE
10
0
20
0
30
0
0
CIRCLE
5
B1
8
SYMBOL
10
0
20
0
30
0
40
1
0
ENDBLK
0
ENDSEC
0
SECTION
2
ENTITIES
0
LINE
5
1
8
WALL
10
0
20
0
30
0
11
100
21
100
31
0
0
INSERT
5
2
8
LIGHTING
2
LED_FIXTURE
10
10
20
20
30
0
0
INSERT
5
3
8
LIGHTING
2
LED_FIXTURE
10
30
20
40
30
0
0
INSERT
5
4
8
DECOR
2
LED_FIXTURE
10
50
20
60
30
0
0
HATCH
5
5
8
FILL
10
5
20
5
0
ENDSEC
0
EOF
`;

function createFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "cad-analysis-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dxfPath = path.join(directory, "sample.dxf");
  writeFileSync(dxfPath, SAMPLE_DXF);
  return { directory, dxfPath };
}

function createConverter(directory, body) {
  const converter = path.join(directory, "fake-dwgread.mjs");
  writeFileSync(converter, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  chmodSync(converter, 0o700);
  return converter;
}

function runAnalyzer(args, env = {}) {
  return spawnSync(process.execPath, [analyzer, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000
  });
}

function parseSuccessfulResult(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("DXF를 직접 분석해 layer/block별 entity와 INSERT, 고유 좌표, 규칙 후보를 안정된 순서로 출력한다", (t) => {
  const fixture = createFixture(t);

  const first = runAnalyzer(["--input", fixture.dxfPath]);
  const second = runAnalyzer(["--input", fixture.dxfPath]);
  const report = parseSuccessfulResult(first);

  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stderr, second.stderr);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.source.format, "dxf");
  assert.equal(report.source.dxfVersion, "AC1027");
  assert.equal(report.statistics.modelSpaceEntityCount, 5);
  assert.equal(report.statistics.insertCount, 3);
  assert.equal(report.statistics.uniqueInsertCoordinateCount, 3);
  assert.deepEqual(report.statistics.entityTypes, [
    { type: "HATCH", count: 1 },
    { type: "INSERT", count: 3 },
    { type: "LINE", count: 1 }
  ]);
  assert.deepEqual(report.statistics.layers, [
    { name: "DECOR", entityCount: 1, insertCount: 1, candidateCount: 0 },
    { name: "FILL", entityCount: 1, insertCount: 0, candidateCount: 0 },
    { name: "LIGHTING", entityCount: 2, insertCount: 2, candidateCount: 2 },
    { name: "WALL", entityCount: 1, insertCount: 0, candidateCount: 0 }
  ]);
  assert.deepEqual(report.statistics.blocks, [
    { name: "LED_FIXTURE", definitionEntityCount: 1, insertCount: 3, candidateCount: 2 }
  ]);
  assert.equal(report.candidates.count, 2);
  assert.equal(report.candidates.uniqueCoordinateCount, 2);
  assert.deepEqual(report.candidates.byBlock, [{ name: "LED_FIXTURE", count: 2 }]);
  assert.deepEqual(report.candidates.byLayer, [{ name: "LIGHTING", count: 2 }]);
  assert.equal(report.accuracy.coordinateAndSymbolExtraction.coverage, 1);
  assert.equal(report.accuracy.supportedEntityMapGeometry.expectedCoverage, 0.8);
  assert.equal(report.accuracy.detection.groundTruthProvided, false);
  assert.equal(report.accuracy.detection.precision, null);
  assert.equal(report.accuracy.detection.f1, null);
  assert.equal(report.accuracy.bleIdentityMapping.accuracy, 0);
  assert.equal(report.accuracy.bleIdentityMapping.autoRegistration, false);
  assert.match(first.stderr, /CAD 가져오기 분석 요약/);
  assert.match(first.stderr, /후보 layer별: LIGHTING 2/);
  assert.match(first.stderr, /후보 block별: LED_FIXTURE 2/);
  assert.match(first.stderr, /실제 BLE 장비 identity 매핑: 0%/);
});

test("LibreDWG가 ANSI_949 헤더와 UTF-8 문자열을 함께 출력해도 한글 layer를 보존한다", (t) => {
  const fixture = createFixture(t);
  const libreDwgOutput = SAMPLE_DXF
    .replace("ANSI_1252", "ANSI_949")
    .replaceAll("LIGHTING", "전등");
  writeFileSync(fixture.dxfPath, libreDwgOutput, "utf8");

  const report = parseSuccessfulResult(runAnalyzer(["--input", fixture.dxfPath]));

  assert.equal(report.source.dxfCodePage, "ANSI_949");
  assert.equal(report.source.dxfTextEncoding, "UTF-8");
  assert.deepEqual(
    report.statistics.layers.find((layer) => layer.name === "전등"),
    { name: "전등", entityCount: 2, insertCount: 2, candidateCount: 2 }
  );
  assert.equal(report.candidates.count, 2);
});

test("ground truth TP/FP/FN으로 precision, recall, F1을 계산한다", (t) => {
  const fixture = createFixture(t);
  const groundTruthPath = path.join(fixture.directory, "ground-truth.json");
  writeFileSync(groundTruthPath, JSON.stringify({ truePositive: 2, falsePositive: 1, falseNegative: 1 }));

  const report = parseSuccessfulResult(runAnalyzer(["--input", fixture.dxfPath, "--ground-truth", groundTruthPath]));

  assert.deepEqual(report.accuracy.detection, {
    groundTruthProvided: true,
    truePositive: 2,
    falsePositive: 1,
    falseNegative: 1,
    precision: 0.666667,
    recall: 0.666667,
    f1: 0.666667
  });
});

test("precision/recall의 분모가 0이면 null이고 정의된 0/0 F1은 0으로 출력한다", (t) => {
  const fixture = createFixture(t);
  const emptyTruthPath = path.join(fixture.directory, "empty-ground-truth.json");
  const missesPath = path.join(fixture.directory, "misses-ground-truth.json");
  writeFileSync(emptyTruthPath, JSON.stringify({ truePositive: 0, falsePositive: 0, falseNegative: 0 }));
  writeFileSync(missesPath, JSON.stringify({ truePositive: 0, falsePositive: 1, falseNegative: 1 }));

  const empty = parseSuccessfulResult(runAnalyzer(["--input", fixture.dxfPath, "--ground-truth", emptyTruthPath]));
  const misses = parseSuccessfulResult(runAnalyzer(["--input", fixture.dxfPath, "--ground-truth", missesPath]));

  assert.equal(empty.accuracy.detection.precision, null);
  assert.equal(empty.accuracy.detection.recall, null);
  assert.equal(empty.accuracy.detection.f1, null);
  assert.equal(misses.accuracy.detection.precision, 0);
  assert.equal(misses.accuracy.detection.recall, 0);
  assert.equal(misses.accuracy.detection.f1, 0);
});

test("DWG converter를 shell 없이 고정 argv로 실행하고 임시 DXF를 항상 정리한다", (t) => {
  const fixture = createFixture(t);
  const tempRoot = path.join(fixture.directory, "temp");
  const dwgPath = path.join(fixture.directory, "drawing;touch-pwned.dwg");
  const argvPath = path.join(fixture.directory, "argv.json");
  const pwnedPath = path.join(root, "touch-pwned.dwg");
  writeFileSync(dwgPath, "fake dwg");
  writeFileSync(tempRoot, "placeholder");
  rmSync(tempRoot);
  const converter = createConverter(fixture.directory, `
    import { copyFileSync, writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    if (args[0] === "--version") { console.log("fake-dwgread 1.0"); process.exit(0); }
    const output = args[args.indexOf("-o") + 1];
    copyFileSync(process.env.TEST_DXF_PATH, output);
    writeFileSync(process.env.TEST_ARGV_PATH, JSON.stringify(args));
  `);

  const result = runAnalyzer(
    ["--input", dwgPath, "--converter", converter, "--temp-root", tempRoot],
    { TEST_DXF_PATH: fixture.dxfPath, TEST_ARGV_PATH: argvPath }
  );
  const report = parseSuccessfulResult(result);
  const argv = JSON.parse(readFileSync(argvPath, "utf8"));

  assert.equal(report.source.format, "dwg");
  assert.equal(report.source.converter.version, "fake-dwgread 1.0");
  assert.deepEqual(argv.slice(0, 4), ["-O", "DXF", "-o", argv[3]]);
  assert.equal(argv[4], dwgPath);
  assert.equal(existsSync(pwnedPath), false);
  assert.deepEqual(readdirSync(tempRoot), []);
});

test("DWG converter가 없으면 명확히 fail-close한다", (t) => {
  const fixture = createFixture(t);
  const dwgPath = path.join(fixture.directory, "sample.dwg");
  writeFileSync(dwgPath, "fake dwg");

  const result = runAnalyzer(["--input", dwgPath]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DWG converter.*required/i);
  assert.equal(result.stdout, "");
});

test("입력 파일과 변환 DXF, converter 출력, 분석 JSON 크기 상한을 fail-close한다", (t) => {
  const fixture = createFixture(t);
  const oversizedInput = runAnalyzer(["--input", fixture.dxfPath, "--max-input-bytes", "16"]);
  assert.notEqual(oversizedInput.status, 0);
  assert.match(oversizedInput.stderr, /input size limit exceeded/i);

  const dwgPath = path.join(fixture.directory, "sample.dwg");
  writeFileSync(dwgPath, "fake dwg");
  const largeFileConverter = createConverter(fixture.directory, `
    import { writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    if (args[0] === "--version") process.exit(0);
    writeFileSync(args[args.indexOf("-o") + 1], "x".repeat(1024));
  `);
  const largeOutput = runAnalyzer([
    "--input", dwgPath, "--converter", largeFileConverter, "--max-converted-bytes", "128"
  ]);
  assert.notEqual(largeOutput.status, 0);
  assert.match(largeOutput.stderr, /converted DXF size limit exceeded/i);

  const noisyConverter = createConverter(fixture.directory, `
    if (process.argv[2] === "--version") { process.stdout.write("x".repeat(1024)); process.exit(0); }
  `);
  const noisyOutput = runAnalyzer([
    "--input", dwgPath, "--converter", noisyConverter, "--max-process-output-bytes", "128"
  ]);
  assert.notEqual(noisyOutput.status, 0);
  assert.match(noisyOutput.stderr, /process output limit exceeded/i);

  const largeJson = runAnalyzer(["--input", fixture.dxfPath, "--max-json-output-bytes", "128"]);
  assert.notEqual(largeJson.status, 0);
  assert.match(largeJson.stderr, /JSON output size limit exceeded/i);
  assert.equal(largeJson.stdout, "");
});

test("converter 제한 시간을 넘으면 실패하고 임시 파일을 정리한다", (t) => {
  const fixture = createFixture(t);
  const tempRoot = path.join(fixture.directory, "temp");
  const dwgPath = path.join(fixture.directory, "sample.dwg");
  writeFileSync(dwgPath, "fake dwg");
  const converter = createConverter(fixture.directory, `
    if (process.argv[2] === "--version") { console.log("slow 1.0"); process.exit(0); }
    setTimeout(() => {}, 5_000);
  `);

  const result = runAnalyzer([
    "--input", dwgPath,
    "--converter", converter,
    "--temp-root", tempRoot,
    "--converter-timeout-ms", "50"
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /converter time limit exceeded/i);
  assert.deepEqual(readdirSync(tempRoot), []);
});
