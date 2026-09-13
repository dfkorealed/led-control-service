import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("build script는 clean full-commit ARM64 provenance bundle과 실제 image inventory를 만든다", async () => {
  const source = await readFile(path.join(root, "scripts/gateway-appliance-build.sh"), "utf8");
  assert.match(source, /linux\/arm64/);
  assert.match(source, /git rev-parse HEAD/);
  assert.doesNotMatch(source, /--short=12|ALLOW_DIRTY_BUILD/);
  assert.match(source, /docker image save/);
  assert.match(source, /docker image inspect/);
  assert.match(source, /gateway-release-bundle\.mjs.*create/);
  assert.match(source, /gateway-release-inventory\.json/);
  assert.match(source, /GATEWAY_RELEASE_TEST_MODE/);
  assert.match(source, /org\.opencontainers\.image\.version/);
  assert.match(source, /org\.opencontainers\.image\.revision/);
  assert.match(source, /com\.led-control\.firmware-compatibility/);
});

// Deployment/lifecycle assertions execute the real scripts with command shims
// in gateway-appliance-release.test.mjs; old source regexes hid unsafe sourcing.

test("deploy script는 잘못된 CLI 인자를 exit 2로 거부한다", () => {
  for (const args of [[], ["gateway@example.test", "image.tar", "unexpected"]]) {
    const result = spawnSync(path.join(root, "scripts/gateway-appliance-deploy.sh"), args, { encoding: "utf8" });
    assert.equal(result.status, 2);
  }
});

test("deploy script는 BIO overlay 대신 격리된 전용 launcher를 안내한다", () => {
  const result = spawnSync(path.join(root, "scripts/gateway-appliance-deploy.sh"), [
    "--adapter", "bio-usb", "gateway@example.test", "bundle"
  ], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /GATEWAY_BIO_STANDALONE_REQUIRED/);
  assert.match(result.stderr, /gateway-bio-runtime\.sh/);
  assert.doesNotMatch(result.stderr, /ssh|scp/);
});

test("deploy script는 unknown adapter를 원격 작업 전에 거부한다", () => {
  const result = spawnSync(path.join(root, "scripts/gateway-appliance-deploy.sh"), [
    "--adapter", "hybrid", "gateway@example.test", "image.tar"
  ], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /ssh|scp/);
});
