import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("deploy script는 image를 먼저 load하고 제조 identity 검증 뒤 Compose를 적용한다", async () => {
  const source = await readFile(path.join(root, "scripts/gateway-appliance-deploy.sh"), "utf8");
  assert.match(source, /sha256sum -c|shasum -a 256 -c/);
  assert.match(source, /docker image load/);
  assert.match(source, /\.env\.appliance/);
  assert.ok(source.indexOf("docker image load") < source.indexOf("제조 identity 누락"));
  assert.match(source, /data\/identity\/device\/current\/\$file/);
  assert.match(source, /sudo test -s "data\/identity\/device\/current\/\$file"/);
  assert.doesNotMatch(source, /data\/certs\/gateway\.crt/);
  assert.match(source, /docker compose/);
  assert.match(source, /--remove-orphans/);
  assert.match(source, /seccomp-bluez-mesh\.json/);
  assert.doesNotMatch(source, /chown -R[^\n]*\$REMOTE_DIR/);
  assert.match(source, /install -d -m 0750/);
});

test("deploy script는 실제 배포한 image 좌표를 appliance 환경 파일에 영속화한다", async () => {
  const source = await readFile(path.join(root, "scripts/gateway-appliance-deploy.sh"), "utf8");

  assert.match(source, /upsert_env_value GATEWAY_IMAGE_REPOSITORY "\$GATEWAY_IMAGE_REPOSITORY"/);
  assert.match(source, /upsert_env_value GATEWAY_IMAGE_TAG "\$GATEWAY_IMAGE_TAG"/);
  assert.match(source, /mktemp "\.env\.appliance\.tmp\.XXXXXX"/);
  assert.match(source, /mv "\$temporary" \.env\.appliance/);
  assert.ok(
    source.indexOf("upsert_env_value GATEWAY_IMAGE_TAG") < source.indexOf("docker compose --env-file"),
    "image tag must be persisted before Compose resolves the service image"
  );
});

test("deploy script는 잘못된 CLI 인자를 exit 2로 거부한다", () => {
  for (const args of [[], ["gateway@example.test", "image.tar", "unexpected"]]) {
    const result = spawnSync(path.join(root, "scripts/gateway-appliance-deploy.sh"), args, { encoding: "utf8" });
    assert.equal(result.status, 2);
  }
});
