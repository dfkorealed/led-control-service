import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const sourceScriptPath = path.join(projectRoot, "scripts", "pki", "lab-vault.sh");

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "lab-vault-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const scriptDir = path.join(repo, "scripts", "pki");
  const scriptPath = path.join(scriptDir, "lab-vault.sh");
  const vaultDir = path.join(repo, ".local", "lab-vault");
  const stateFile = path.join(root, "docker-state");
  const logFile = path.join(root, "docker.log");
  const configFile = path.join(root, "docker-config-input.log");
  await mkdir(scriptDir, { recursive: true });
  await mkdir(bin, { recursive: true });
  await copyFile(sourceScriptPath, scriptPath);
  await chmod(scriptPath, 0o755);

  const docker = path.join(bin, "docker");
  await writeFile(docker, String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${logFile}"
state_file="${stateFile}"
case "$1" in
  ps)
    [[ -f "$state_file" ]] && printf 'lab-vault-container\n'
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
    {
      printf 'args=%s\n' "$*"
      printenv VAULT_DEV_ROOT_TOKEN_ID || true
    } > "${configFile}"
    [[ "$FAKE_DOCKER_RUN_FAIL" != "1" ]] || exit 1
    printf 'running' > "$state_file"
    printf 'lab-vault-container\n'
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
    printf 'unexpected docker command: %s\n' "$*" >&2
    exit 1
    ;;
esac
`);
  await chmod(docker, 0o755);
  return { root, repo, bin, scriptPath, vaultDir, stateFile, logFile, configFile };
}

function run(fixture, args = [], overrides = {}) {
  return spawnSync("/bin/bash", [fixture.scriptPath, ...args], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      PKI_ENV: "lab",
      FAKE_DOCKER_SCOPE: "lab-vault",
      FAKE_DOCKER_RUN_FAIL: "0",
      VAULT_DEV_ROOT_TOKEN_ID: "",
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

test("제품 스크립트는 고정 경계만 사용하고 root token을 Docker 설정과 argv에 전달하지 않는다", async () => {
  const fixture = await createFixture();
  const result = run(fixture, ["start"]);

  assert.equal(result.status, 0, result.stderr);
  const tokenPath = path.join(fixture.vaultDir, "root-token");
  const token = (await readFile(tokenPath, "utf8")).trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  assert.equal((await stat(fixture.vaultDir)).mode & 0o777, 0o700);

  const source = await readFile(fixture.scriptPath, "utf8");
  assert.doesNotMatch(source, /LAB_VAULT_TEST_|DOCKER_BIN|NODE_TEST_CONTEXT/);
  assert.match(source, /LAB_VAULT_CONTAINER="led-control-lab-vault"/);
  assert.match(source, /LAB_VAULT_DIR="\$LOCAL_DIR\/lab-vault"/);

  const log = await readFile(fixture.logFile, "utf8");
  const configInput = await readFile(fixture.configFile, "utf8");
  assert.doesNotMatch(log, new RegExp(token));
  assert.doesNotMatch(configInput, new RegExp(token));
  assert.doesNotMatch(result.stdout, new RegExp(token));
  assert.match(log, /127\.0\.0\.1:18200:8200/);
  assert.match(log, /--label led-control.scope=lab-vault/);
  assert.match(log, /root-token:ro/);
  assert.match(log, /--entrypoint sh/);
  assert.match(log, /export VAULT_DEV_ROOT_TOKEN_ID/);
  assert.match(log, /exec vault server -dev/);
  assert.doesNotMatch(log, /--env VAULT_DEV_ROOT_TOKEN_ID|-dev-root-token-id/);
  assert.match(configInput, /^args=.*root-token:ro/m);
  assert.doesNotMatch(configInput, /--env VAULT_DEV_ROOT_TOKEN_ID|-dev-root-token-id/);
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

test("reset은 명시 확인과 Lab 소유 label이 있을 때만 임시 repo의 Lab 파일을 제거한다", async () => {
  const fixture = await createFixture();
  assert.equal(run(fixture, ["start"]).status, 0);
  await writeFile(path.join(fixture.root, "unrelated.txt"), "keep");

  const rejected = run(fixture, ["reset"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--confirm-lab-destroy/);
  assert.ok(await stat(fixture.vaultDir));

  const unowned = run(fixture, ["reset", "--confirm-lab-destroy"], { FAKE_DOCKER_SCOPE: "other" });
  assert.equal(unowned.status, 1);
  assert.match(unowned.stderr, /소유 label/);
  assert.ok(await stat(fixture.vaultDir));

  const reset = run(fixture, ["reset", "--confirm-lab-destroy"]);
  assert.equal(reset.status, 0, reset.stderr);
  await assert.rejects(stat(fixture.vaultDir));
  assert.equal(await readFile(path.join(fixture.root, "unrelated.txt"), "utf8"), "keep");
});

test("symlink는 제거하지 않고 유효 범위 밖 포트와 Docker run 실패는 안전하게 처리한다", async () => {
  const symlinkFixture = await createFixture();
  const target = path.join(symlinkFixture.root, "target");
  await mkdir(path.dirname(symlinkFixture.vaultDir), { recursive: true });
  await mkdir(target);
  await writeFile(path.join(target, "keep"), "keep");
  await symlink(target, symlinkFixture.vaultDir);
  const symlinkReset = run(symlinkFixture, ["reset", "--confirm-lab-destroy"]);
  assert.equal(symlinkReset.status, 1);
  assert.match(symlinkReset.stderr, /symlink/);
  assert.equal(await readFile(path.join(target, "keep"), "utf8"), "keep");

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
