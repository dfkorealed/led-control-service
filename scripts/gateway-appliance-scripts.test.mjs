import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("build script는 ARM64 immutable image archive와 checksum을 만든다", async () => {
  const source = await readFile(path.join(root, "scripts/gateway-appliance-build.sh"), "utf8");
  assert.match(source, /--platform linux\/arm64/);
  assert.match(source, /git rev-parse --short=12 HEAD/);
  assert.match(source, /docker image save/);
  assert.match(source, /sha256sum|shasum -a 256/);
});

test("deploy script는 checksum과 필수 설정을 검증한 뒤 Compose를 적용한다", async () => {
  const source = await readFile(path.join(root, "scripts/gateway-appliance-deploy.sh"), "utf8");
  assert.match(source, /sha256sum -c|shasum -a 256 -c/);
  assert.match(source, /docker image load/);
  assert.match(source, /\.env\.appliance/);
  assert.match(source, /gateway\.crt/);
  assert.match(source, /docker compose/);
  assert.match(source, /--remove-orphans/);
});
