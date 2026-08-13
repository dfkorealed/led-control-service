import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const scriptPath = path.join(projectRoot, "scripts", "pki", "lab-vault.sh");

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "lab-vault-"));
  const bin = path.join(root, "bin");
  const vaultDir = path.join(root, "lab-vault");
  const stateFile = path.join(root, "docker-state");
  const logFile = path.join(root, "docker.log");
  await mkdir(bin, { recursive: true });
  const docker = path.join(bin, "docker");
  await writeFile(docker, String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${logFile}"
state_file="${stateFile}"
case "$1" in
  ps)
    [[ -f "$state_file" ]] && cat "$state_file"
    true
    ;;
  inspect)
    [[ -f "$state_file" ]] || exit 1
    if [[ "$*" == *".Config.Labels"* ]]; then
      printf '%s\n' "$FAKE_DOCKER_SCOPE"
    else
      cat "$state_file"
    fi
    ;;
  run)
    [[ "$FAKE_DOCKER_RUN_FAIL" != "1" ]] || exit 1
    printf 'running' > "$state_file"
    printf 'lab-vault-container\\n'
    ;;
  start)
    printf 'running' > "$state_file"
    ;;
  stop)
    printf 'stopped' > "$state_file"
    ;;
  rm)
    rm -f "$state_file"
    ;;
  exec)
    exit 0
    ;;
  *)
    printf 'unexpected docker command: %s\\n' "$*" >&2
    exit 1
    ;;
esac
`);
  await chmod(docker, 0o755);
  return { root, bin, vaultDir, stateFile, logFile };
}

function run(fixture, args = [], overrides = {}) {
  return spawnSync("/bin/bash", [scriptPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      PKI_ENV: "lab",
      LAB_VAULT_TEST_MODE: "1",
      NODE_TEST_CONTEXT: "lab-vault-contract",
      LAB_VAULT_TEST_DIR: fixture.vaultDir,
      LAB_VAULT_TEST_DOCKER_BIN: path.join(fixture.bin, "docker"),
      FAKE_DOCKER_SCOPE: "lab-vault",
      FAKE_DOCKER_RUN_FAIL: "0",
      ...overrides
    }
  });
}

test("production 환경에서는 Docker를 실행하지 않고 거부한다", async () => {
  const fixture = await createFixture();
  const result = run(fixture, ["start"], { PKI_ENV: "production" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /PKI_ENV=lab/);
  await assert.rejects(readFile(fixture.logFile, "utf8"));
});

test("start는 root token을 0600으로 만들고 실행 인자에 secret을 남기지 않는다", async () => {
  const fixture = await createFixture();
  const result = run(fixture, ["start"]);

  assert.equal(result.status, 0, result.stderr);
  const tokenPath = path.join(fixture.vaultDir, "root-token");
  const token = (await readFile(tokenPath, "utf8")).trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  assert.equal((await stat(fixture.vaultDir)).mode & 0o777, 0o700);

  const log = await readFile(fixture.logFile, "utf8");
  assert.doesNotMatch(log, new RegExp(token));
  assert.doesNotMatch(result.stdout, new RegExp(token));
  assert.match(log, /127\.0\.0\.1:18200:8200/);
  assert.match(log, /--label led-control.scope=lab-vault/);
  assert.match(log, /--env VAULT_DEV_ROOT_TOKEN_ID/);
  assert.match(log, /--env VAULT_DEV_LISTEN_ADDRESS/);
  assert.match(log, /server -dev/);
  assert.doesNotMatch(log, /-dev-root-token-id/);
  assert.doesNotMatch(log, /root-token:ro/);
});

test("제품 실행은 테스트 전용 경로와 Docker 주입을 거부한다", async () => {
  const fixture = await createFixture();
  const result = run(fixture, ["start"], {
    LAB_VAULT_TEST_MODE: "",
    NODE_TEST_CONTEXT: "",
    LAB_VAULT_TEST_DIR: fixture.vaultDir,
    LAB_VAULT_TEST_DOCKER_BIN: path.join(fixture.bin, "docker")
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node 계약 테스트/);
  await assert.rejects(readFile(fixture.logFile, "utf8"));
});

test("제품 실행은 Lab container, 삭제 경로, Docker 실행 파일 재정의를 거부한다", async () => {
  const fixture = await createFixture();
  const result = run(fixture, ["reset", "--confirm-lab-destroy"], {
    LAB_VAULT_TEST_MODE: "",
    NODE_TEST_CONTEXT: "",
    LAB_VAULT_TEST_DIR: "",
    LAB_VAULT_TEST_DOCKER_BIN: "",
    LAB_VAULT_CONTAINER: "important-container",
    LAB_VAULT_DIR: path.join(fixture.root, "other", "lab-vault"),
    DOCKER_BIN: path.join(fixture.bin, "docker")
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /경계는 재정의할 수 없습니다/);
  await assert.rejects(readFile(fixture.logFile, "utf8"));
});

test("start는 실행 중인 Lab Vault를 다시 생성하지 않는다", async () => {
  const fixture = await createFixture();
  assert.equal(run(fixture, ["start"]).status, 0);
  assert.equal(run(fixture, ["start"]).status, 0);

  const log = await readFile(fixture.logFile, "utf8");
  assert.equal(log.split("\n").filter((line) => line.startsWith("run ")).length, 1);
});

test("status는 Vault status를 실행하고 stop은 Lab identity를 보존한다", async () => {
  const fixture = await createFixture();
  assert.equal(run(fixture, ["start"]).status, 0);
  const tokenPath = path.join(fixture.vaultDir, "root-token");
  const token = await readFile(tokenPath, "utf8");

  const status = run(fixture, ["status"]);
  assert.equal(status.status, 0, status.stderr);
  const stopped = run(fixture, ["stop"]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(await readFile(tokenPath, "utf8"), token);

  const log = await readFile(fixture.logFile, "utf8");
  assert.match(log, /exec .* vault status -address=http:\/\/127\.0\.0\.1:8200/);
  assert.match(log, /stop /);
  assert.doesNotMatch(log, /rm -f/);
});

test("reset은 명시 확인 없이는 거부하고 확인 시 Lab 파일과 container만 제거한다", async () => {
  const fixture = await createFixture();
  assert.equal(run(fixture, ["start"]).status, 0);
  await writeFile(path.join(fixture.root, "unrelated.txt"), "keep");

  const rejected = run(fixture, ["reset"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--confirm-lab-destroy/);
  assert.ok(await stat(fixture.vaultDir));

  const reset = run(fixture, ["reset", "--confirm-lab-destroy"]);
  assert.equal(reset.status, 0, reset.stderr);
  await assert.rejects(stat(fixture.vaultDir));
  assert.equal(await readFile(path.join(fixture.root, "unrelated.txt"), "utf8"), "keep");
});

test("reset은 Lab 소유 label이 없는 동일 이름 container와 symlink를 제거하지 않는다", async () => {
  const fixture = await createFixture();
  assert.equal(run(fixture, ["start"]).status, 0);

  const unowned = run(fixture, ["reset", "--confirm-lab-destroy"], { FAKE_DOCKER_SCOPE: "other" });
  assert.equal(unowned.status, 1);
  assert.match(unowned.stderr, /소유 label/);
  assert.ok(await stat(fixture.vaultDir));

  const symlinkFixture = await createFixture();
  const target = path.join(symlinkFixture.root, "target");
  await mkdir(target);
  await writeFile(path.join(target, "keep"), "keep");
  await symlink(target, symlinkFixture.vaultDir);
  const symlinkReset = run(symlinkFixture, ["reset", "--confirm-lab-destroy"]);
  assert.equal(symlinkReset.status, 1);
  assert.match(symlinkReset.stderr, /symlink/);
  assert.equal(await readFile(path.join(target, "keep"), "utf8"), "keep");
});

test("유효 범위 밖 포트는 Docker 전에 거부하고 run 실패 시 새 token을 정리한다", async () => {
  const invalidPortFixture = await createFixture();
  const invalidPort = run(invalidPortFixture, ["start"], { LAB_VAULT_PORT: "65536" });
  assert.equal(invalidPort.status, 1);
  assert.match(invalidPort.stderr, /1부터 65535/);
  await assert.rejects(readFile(invalidPortFixture.logFile, "utf8"));

  const failingRunFixture = await createFixture();
  const failure = run(failingRunFixture, ["start"], { FAKE_DOCKER_RUN_FAIL: "1" });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /시작에 실패/);
  await assert.rejects(stat(path.join(failingRunFixture.vaultDir, "root-token")));
});
