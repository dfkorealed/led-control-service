import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const mobileRequire = createRequire(path.join(projectRoot, "apps/mobile/package.json"));
const reactNativeRequire = createRequire(mobileRequire.resolve("react-native/package.json"));
const cliPluginRequire = createRequire(reactNativeRequire.resolve("@react-native/community-cli-plugin/package.json"));
const metroRequire = createRequire(cliPluginRequire.resolve("metro/package.json"));
const imageSizePath = metroRequire.resolve("image-size");

const childProgram = String.raw`
const imageSize = require(process.argv[1]);
try {
  const result = imageSize(Buffer.from(process.argv[2], "base64"));
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error.message);
  process.exit(23);
}
`;

test("patched image-size는 악성 ICNS/JXL/HEIF shape을 parser 진입 전에 fail-closed한다", () => {
  const maliciousInputs = {
    icns: maliciousIcns(),
    jxl: maliciousJxl(),
    heif: maliciousHeif()
  };

  for (const [type, input] of Object.entries(maliciousInputs)) {
    const result = runImageSize(input);
    assert.equal(result.signal, null, `${type} parser timed out instead of failing closed`);
    assert.equal(result.status, 23, `${type}: ${result.stderr || result.stdout}`);
    assert.equal(result.stderr, `security-disabled image type: ${type}`);
  }
});

test("image-size 보안 patch는 허용된 PNG asset 해석을 유지한다", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const result = runImageSize(png);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { height: 1, width: 1, type: "png" });
});

function runImageSize(input) {
  return spawnSync(process.execPath, ["-e", childProgram, imageSizePath, input.toString("base64")], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 500
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
