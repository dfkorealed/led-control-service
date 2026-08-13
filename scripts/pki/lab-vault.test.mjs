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
  const initializedFile = path.join(root, "initialized");
  const unsealedFile = path.join(root, "unsealed");
  const unsealCountFile = path.join(root, "unseal-count");
  const logFile = path.join(root, "docker.log");
  const configInputFile = path.join(root, "docker-config-input.log");
  await mkdir(scriptDir, { recursive: true });
  await mkdir(bin, { recursive: true });
  await copyFile(sourceScriptPath, scriptPath);
  await chmod(scriptPath, 0o755);

  const docker = path.join(bin, "docker");
  await writeFile(docker, String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${logFile}"
state_file="${stateFile}"
initialized_file="${initializedFile}"
unsealed_file="${unsealedFile}"
unseal_count_file="${unsealCountFile}"
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
      env
    } > "${configInputFile}"
    [[ "$FAKE_DOCKER_RUN_FAIL" != "1" ]] || exit 1
    printf 'running' > "$state_file"
    rm -f "$unsealed_file"
    printf 'lab-vault-container\n'
    ;;
  start)
    printf 'running' > "$state_file"
    rm -f "$unsealed_file"
    ;;
  stop)
    printf 'stopped' > "$state_file"
    ;;
  rm)
    rm -f "$state_file" "$initialized_file" "$unsealed_file"
    ;;
  exec)
    if [[ " $* " == *" vault status -format=json "* ]]; then
      if [[ ! -f "$initialized_file" ]]; then
        printf '{"initialized":false,"sealed":true}\n'
        exit 2
      fi
      if [[ -f "$unsealed_file" ]]; then
        printf '{"initialized":true,"sealed":false}\n'
      else
        printf '{"initialized":true,"sealed":true}\n'
      fi
      exit 0
    fi
    if [[ " $* " == *" vault operator init -key-shares=1 -key-threshold=1 -format=json "* ]]; then
      printf 'initialized\n' > "$initialized_file"
      printf '{"root_token":"fake-root-token","keys_base64":["fake-unseal-key"]}\n'
      exit 0
    fi
    if [[ " $* " == *" vault operator unseal "* ]]; then
      read -r supplied_key
      [[ "$supplied_key" == "fake-unseal-key" ]] || exit 1
      printf 'unsealed\n' > "$unsealed_file"
      count=0
      [[ -f "$unseal_count_file" ]] && count="$(cat "$unseal_count_file")"
      printf '%s\n' "$((count + 1))" > "$unseal_count_file"
      exit 0
    fi
    exit 0
    ;;
  *)
    printf 'unexpected docker command: %s\n' "$*" >&2
    exit 1
    ;;
esac
`);
  await chmod(docker, 0o755);
  return { root, repo, bin, scriptPath, vaultDir, logFile, configInputFile, unsealCountFile };
}

function run(fixture, args = [], overrides = {}) {
  return spawnSync("/bin/bash", [fixture.scriptPath, ...args], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      PKI_ENV: "lab",
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

test("start는 persistent file-storage Vault를 init 및 unseal하고 secret을 Docker 설정과 출력에 남기지 않는다", async () => {
  const fixture = await createFixture();
  const result = run(fixture, ["start"]);

  assert.equal(result.status, 0, result.stderr);
  const config = await readFile(path.join(fixture.vaultDir, "config.hcl"), "utf8");
  const rootToken = (await readFile(path.join(fixture.vaultDir, "root-token"), "utf8")).trim();
  const unsealKey = (await readFile(path.join(fixture.vaultDir, "unseal-key"), "utf8")).trim();
  assert.match(config, /storage "file"[\s\S]*path = "\/vault\/file"/);
  assert.match(config, /address = "0\.0\.0\.0:8200"/);
  assert.match(config, /tls_disable = 1/);
  assert.match(config, /api_addr = "http:\/\/127\.0\.0\.1:18200"/);
  assert.doesNotMatch(config, /dev|root_token|unseal/i);
  assert.equal((await stat(path.join(fixture.vaultDir, "root-token"))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(fixture.vaultDir, "unseal-key"))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(fixture.vaultDir, "data"))).mode & 0o777, 0o700);

  const log = await readFile(fixture.logFile, "utf8");
  const configInput = await readFile(fixture.configInputFile, "utf8");
  for (const secret of [rootToken, unsealKey]) {
    assert.doesNotMatch(log, new RegExp(secret));
    assert.doesNotMatch(configInput, new RegExp(secret));
    assert.doesNotMatch(result.stdout, new RegExp(secret));
  }
  assert.match(log, /--volume .*\/data:\/vault\/file/);
  assert.match(log, /--volume .*config\.hcl:\/vault\/config\/config\.hcl:ro/);
  assert.match(log, /server -config=\/vault\/config\/config\.hcl/);
  assert.doesNotMatch(log, /-dev|VAULT_DEV_ROOT_TOKEN_ID|--env/);
  assert.match(log, /operator init -key-shares=1 -key-threshold=1 -format=json/);
  assert.match(log, /exec -i .*operator unseal/);
});

test("stop은 data와 credentials를 보존하고 재시작은 저장된 unseal key를 stdin으로 사용한다", async () => {
  const fixture = await createFixture();
  assert.equal(run(fixture, ["start"]).status, 0);
  const rootToken = await readFile(path.join(fixture.vaultDir, "root-token"), "utf8");
  const unsealKey = await readFile(path.join(fixture.vaultDir, "unseal-key"), "utf8");
  assert.equal(run(fixture, ["stop"]).status, 0);
  assert.equal(run(fixture, ["start"]).status, 0);

  assert.equal(await readFile(path.join(fixture.vaultDir, "root-token"), "utf8"), rootToken);
  assert.equal(await readFile(path.join(fixture.vaultDir, "unseal-key"), "utf8"), unsealKey);
  assert.equal((await readFile(fixture.unsealCountFile, "utf8")).trim(), "2");
  const log = await readFile(fixture.logFile, "utf8");
  assert.equal(log.split("\n").filter((line) => line.startsWith("run ")).length, 1);
  assert.equal(log.split("\n").filter((line) => /operator init /.test(line)).length, 1);
  assert.equal(log.split("\n").filter((line) => /operator unseal/.test(line)).length, 2);
  assert.doesNotMatch(log, new RegExp(unsealKey.trim()));
});

test("reset은 명시 확인과 Lab 소유 label이 있을 때만 임시 repo의 persistent Vault를 제거한다", async () => {
  const fixture = await createFixture();
  assert.equal(run(fixture, ["start"]).status, 0);
  await writeFile(path.join(fixture.root, "unrelated.txt"), "keep");

  const rejected = run(fixture, ["reset"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--confirm-lab-destroy/);

  const unowned = run(fixture, ["reset", "--confirm-lab-destroy"], { FAKE_DOCKER_SCOPE: "other" });
  assert.equal(unowned.status, 1);
  assert.match(unowned.stderr, /소유 label/);
  assert.ok(await stat(fixture.vaultDir));

  const reset = run(fixture, ["reset", "--confirm-lab-destroy"]);
  assert.equal(reset.status, 0, reset.stderr);
  await assert.rejects(stat(fixture.vaultDir));
  assert.equal(await readFile(path.join(fixture.root, "unrelated.txt"), "utf8"), "keep");
});

test("symlink, 잘못된 포트, Docker run 실패는 artifact를 안전하게 처리한다", async () => {
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
  await assert.rejects(stat(path.join(failingRunFixture.vaultDir, "unseal-key")));
});
