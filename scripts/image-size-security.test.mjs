import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const mobileRequire = createRequire(path.join(projectRoot, "apps/mobile/package.json"));
const manifest = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const usesLegacyPatch = manifest.pnpm?.patchedDependencies?.["image-size@1.2.1"] === "patches/image-size@1.2.1.patch";
const hasExpoApp = typeof mobileRequire("./package.json").dependencies?.expo === "string";
assert.ok(hasExpoApp || usesLegacyPatch, "The mobile asset parser must have an Expo or exact patched legacy graph");
// Expo's asset worker imports this wrapper. Resolve the same export rather than
// a hoisted image-size package that may remain from an earlier installation.
const assetParserPath = hasExpoApp ? resolveExpoAssets() : undefined;
const pngFixture = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function resolveExpoAssets() {
  const expoRequire = createRequire(mobileRequire.resolve("expo/package.json"));
  const metroConfigRequire = createRequire(expoRequire.resolve("@expo/metro-config/package.json"));
  return metroConfigRequire.resolve("@expo/metro/metro/Assets");
}

const childProgram = String.raw`
const { getAssetSize } = require(process.argv[1]);
try {
  const result = getAssetSize(process.argv[3], Buffer.from(process.argv[2], "base64"), "security-fixture");
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error.message);
  process.exit(23);
}
`;

if (hasExpoApp) {
  test("앱 Metro asset parser는 이미지 확장자로 가장한 악성 ICNS/JXL/HEIF 바이트를 bounded 시간 안에 거부한다", () => {
    const maliciousInputs = {
      icns: maliciousIcns(),
      jxl: maliciousJxl(),
      heif: maliciousHeif()
    };

    for (const [type, input] of Object.entries(maliciousInputs)) {
      for (const extension of ["png", "jpg", "jpeg", "bmp", "gif", "webp", "psd", "svg", "tiff", "ktx"]) {
        const result = runAssetParser(input, extension);
        assert.equal(result.signal, null, `${type} as ${extension} parser timed out instead of failing closed`);
        assert.equal(result.status, 23, `${type} as ${extension}: ${result.stderr || result.stdout}`);
        assert.match(result.stderr, /Invalid .* image asset/);
      }
    }
  });

  test("앱 Metro asset parser는 정상 PNG asset의 실제 크기를 유지한다", () => {
    const result = runAssetParser(pngFixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { height: 1, width: 1 });
  });
}

function runAssetParser(input, extension = "png") {
  return runParser(childProgram, assetParserPath, input, [extension]);
}

function runParser(program, parserPath, input, args = []) {
  return spawnSync(process.execPath, ["-e", program, parserPath, input.toString("base64"), ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 500
  });
}

// The retained audit exception applies only to the exact historical patched
// graph. Never resolve a leftover legacy package for the current Expo graph.
if (usesLegacyPatch) {
  const reactNativeRequire = createRequire(mobileRequire.resolve("react-native/package.json"));
  const cliPluginRequire = createRequire(reactNativeRequire.resolve("@react-native/community-cli-plugin/package.json"));
  const metroRequire = createRequire(cliPluginRequire.resolve("metro/package.json"));
  const imageSizePath = metroRequire.resolve("image-size");
  assert.equal(metroRequire("image-size/package.json").version, "1.2.1");
  const legacyProgram = String.raw`
const imageSize = require(process.argv[1]);
try {
  process.stdout.write(JSON.stringify(imageSize(Buffer.from(process.argv[2], "base64"))));
} catch (error) {
  process.stderr.write(error.message);
  process.exit(23);
}
`;
  test("exact selector가 유지된 legacy image-size patch는 악성 signature를 parser 전에 거부한다", () => {
    for (const [type, input] of Object.entries({ icns: maliciousIcns(), jxl: maliciousJxl(), heif: maliciousHeif() })) {
      const result = runParser(legacyProgram, imageSizePath, input);
      assert.equal(result.signal, null, `${type} legacy parser timed out`);
      assert.equal(result.status, 23, result.stderr || result.stdout);
      assert.equal(result.stderr, `security-disabled image type: ${type}`);
    }
  });
  test("exact selector가 유지된 legacy image-size patch는 정상 PNG asset을 유지한다", () => {
    const result = runParser(legacyProgram, imageSizePath, pngFixture);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { height: 1, width: 1, type: "png" });
  });
}

function maliciousIcns() {
  const input = Buffer.alloc(24);
  input.write("icns", 0, "ascii");
  input.writeUInt32BE(24, 4);
  input.write("ic07", 8, "ascii");
  input.writeUInt32BE(8, 12);
  input.write("ic07", 16, "ascii");
  input.writeUInt32BE(0, 20);
  return input;
}

function maliciousJxl() {
  const input = Buffer.alloc(24);
  input.writeUInt32BE(12, 0);
  input.write("JXL ", 4, "ascii");
  input.set([0x0d, 0x0a, 0x87, 0x0a], 8);
  input.writeUInt32BE(0, 12);
  input.write("ftyp", 16, "ascii");
  input.write("jxl ", 20, "ascii");
  return input;
}

function maliciousHeif() {
  const input = Buffer.alloc(20);
  input.writeUInt32BE(0, 0);
  input.write("ftyp", 4, "ascii");
  input.write("avif", 8, "ascii");
  return input;
}
