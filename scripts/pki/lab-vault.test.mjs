import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const sourceScriptPath = path.join(projectRoot, "scripts", "pki", "lab-vault.sh");

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

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
  const unsealRequestFile = path.join(root, "unseal-request.json");
  const serverPidFile = path.join(root, "fake-vault-server.pid");
  const serverReadyFile = path.join(root, "fake-vault-server.ready");
  const serverScript = path.join(root, "fake-vault-server.mjs");
  const logFile = path.join(root, "docker.log");
  const configInputFile = path.join(root, "docker-config-input.log");
  const nodeArgvLogFile = path.join(root, "node-argv.log");
  const port = await reservePort();
  await mkdir(scriptDir, { recursive: true });
  await mkdir(bin, { recursive: true });
  await copyFile(sourceScriptPath, scriptPath);
  await chmod(scriptPath, 0o755);

  await writeFile(serverScript, `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const [port, requestFile, unsealedFile, readyFile, mode] = process.argv.slice(2);
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    writeFileSync(requestFile, JSON.stringify({ method: request.method, path: request.url, headers: request.headers, body }));
    if (mode === "http-error") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ errors: ["fake-unseal-key"] }));
      return;
    }
    if (mode === "still-sealed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sealed: true, diagnostic: "fake-unseal-key" }));
      return;
    }
    const parsed = JSON.parse(body);
    if (request.method !== "POST" || request.url !== "/v1/sys/unseal" || parsed.key !== "fake-unseal-key") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ errors: ["invalid request"] }));
      return;
    }
    writeFileSync(unsealedFile, "unsealed\\n");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ sealed: false }));
  });
});
server.listen(Number(port), "127.0.0.1", () => writeFileSync(readyFile, "ready\\n"));
`);

  const node = path.join(bin, "node");
  await writeFile(node, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${nodeArgvLogFile}"
exec "${process.execPath}" "$@"
`);
  await chmod(node, 0o755);

  const docker = path.join(bin, "docker");
  await writeFile(docker, String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${logFile}"
state_file="${stateFile}"
initialized_file="${initializedFile}"
unsealed_file="${unsealedFile}"
unseal_count_file="${unsealCountFile}"
server_pid_file="${serverPidFile}"
server_ready_file="${serverReadyFile}"
start_server() {
  rm -f "$server_ready_file"
  node "${serverScript}" "$LAB_VAULT_PORT" "${unsealRequestFile}" "$unsealed_file" "$server_ready_file" "$FAKE_UNSEAL_RESPONSE_MODE" >/dev/null 2>&1 &
  printf '%s\n' "$!" > "$server_pid_file"
  for _ in {1..100}; do
    [[ -f "$server_ready_file" ]] && return
    sleep 0.01
  done
  exit 1
}
stop_server() {
  if [[ -f "$server_pid_file" ]]; then
    pid="$(cat "$server_pid_file")"
    kill "$pid" 2>/dev/null || true
    for _ in {1..100}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.01
    done
    rm -f "$server_pid_file" "$server_ready_file"
  fi
}
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
    start_server
    printf 'lab-vault-container\n'
    ;;
  start)
    printf 'running' > "$state_file"
    rm -f "$unsealed_file"
    start_server
    ;;
  stop)
    stop_server
    printf 'stopped' > "$state_file"
    ;;
  rm)
    stop_server
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
      printf '{"root_token":"fake-root-token","unseal_keys_b64":["fake-unseal-key"]}\n'
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
  return { root, repo, bin, scriptPath, vaultDir, logFile, configInputFile, unsealCountFile, unsealRequestFile, nodeArgvLogFile, port };
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
      FAKE_UNSEAL_RESPONSE_MODE: "success",
      LAB_VAULT_PORT: String(fixture.port),
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
  assert.match(config, new RegExp(`api_addr = "http:\\/\\/127\\.0\\.0\\.1:${fixture.port}"`));
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
  const initCommands = log.split("\n").filter((line) => /vault operator init/.test(line));
  assert.equal(initCommands.length, 1);
  assert.match(initCommands[0], /-address=http:\/\/127\.0\.0\.1:8200/);
  assert.doesNotMatch(log, /operator unseal/);
  const statusCommands = log.split("\n").filter((line) => /vault status/.test(line));
  assert.ok(statusCommands.length > 0);
  for (const command of statusCommands) {
    assert.match(command, /-address=http:\/\/127\.0\.0\.1:8200/);
  }
  const request = JSON.parse(await readFile(fixture.unsealRequestFile, "utf8"));
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/v1/sys/unseal");
  assert.equal(request.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(request.body), { key: unsealKey });
  const nodeArgvLog = await readFile(fixture.nodeArgvLogFile, "utf8");
  assert.match(nodeArgvLog, new RegExp(`- .*unseal-key ${fixture.port}`));
  assert.doesNotMatch(nodeArgvLog, new RegExp(unsealKey));
  assert.equal(run(fixture, ["reset", "--confirm-lab-destroy"]).status, 0);
});

test("stop은 data와 credentials를 보존하고 재시작은 저장된 unseal key를 HTTP body로 사용한다", async () => {
  const fixture = await createFixture();
  assert.equal(run(fixture, ["start"]).status, 0);
  const rootToken = await readFile(path.join(fixture.vaultDir, "root-token"), "utf8");
  const unsealKey = await readFile(path.join(fixture.vaultDir, "unseal-key"), "utf8");
  assert.equal(run(fixture, ["stop"]).status, 0);
  const restarted = run(fixture, ["start"]);
  assert.equal(restarted.status, 0, JSON.stringify({ stdout: restarted.stdout, stderr: restarted.stderr, root: fixture.root }));

  assert.equal(await readFile(path.join(fixture.vaultDir, "root-token"), "utf8"), rootToken);
  assert.equal(await readFile(path.join(fixture.vaultDir, "unseal-key"), "utf8"), unsealKey);
  const log = await readFile(fixture.logFile, "utf8");
  assert.equal(log.split("\n").filter((line) => line.startsWith("run ")).length, 1);
  assert.equal(log.split("\n").filter((line) => /operator init /.test(line)).length, 1);
  assert.equal(log.split("\n").filter((line) => /operator unseal/.test(line)).length, 0);
  assert.doesNotMatch(log, new RegExp(unsealKey.trim()));
  assert.equal(run(fixture, ["reset", "--confirm-lab-destroy"]).status, 0);
});

test("unseal HTTP status와 sealed 응답을 검증하고 오류 body의 secret을 출력하지 않는다", async () => {
  for (const mode of ["http-error", "still-sealed"]) {
    const fixture = await createFixture();
    const result = run(fixture, ["start"], { FAKE_UNSEAL_RESPONSE_MODE: mode });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unseal에 실패/);
    assert.doesNotMatch(result.stdout, /fake-unseal-key/);
    assert.doesNotMatch(result.stderr, /fake-unseal-key/);
    const nodeArgvLog = await readFile(fixture.nodeArgvLogFile, "utf8");
    assert.doesNotMatch(nodeArgvLog, /fake-unseal-key/);
    run(fixture, ["reset", "--confirm-lab-destroy"]);
  }
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

test("실제 Vault 1.17.6은 최초 init 후 stop/start에서도 unseal된다", {
  skip: process.env.LAB_VAULT_INTEGRATION !== "1"
}, async (context) => {
  const dockerInfo = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (dockerInfo.status !== 0) return context.skip("Docker daemon을 사용할 수 없습니다.");

  const image = spawnSync("docker", ["image", "inspect", "hashicorp/vault:1.17.6"], { encoding: "utf8" });
  if (image.status !== 0) return context.skip("hashicorp/vault:1.17.6 이미지가 로컬에 없습니다.");

  const existing = spawnSync("docker", ["ps", "-aq", "--filter", "name=^/led-control-lab-vault$"], { encoding: "utf8" });
  if (existing.stdout.trim()) return context.skip("동일 이름의 Lab Vault container가 이미 있습니다.");

  await mkdir(path.join(projectRoot, ".local"), { recursive: true });
  const root = await mkdtemp(path.join(projectRoot, ".local", "lab-vault-integration-"));
  const scriptDir = path.join(root, "scripts", "pki");
  const scriptPath = path.join(scriptDir, "lab-vault.sh");
  const port = await reservePort();
  await mkdir(scriptDir, { recursive: true });
  await copyFile(sourceScriptPath, scriptPath);
  await chmod(scriptPath, 0o755);

  const invoke = (args) => spawnSync("/bin/bash", [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PKI_ENV: "lab", LAB_VAULT_PORT: String(port) }
  });
  context.after(async () => {
    invoke(["reset", "--confirm-lab-destroy"]);
    await rm(root, { recursive: true, force: true });
  });

  const firstStart = invoke(["start"]);
  const firstStartLogs = firstStart.status === 0
    ? ""
    : spawnSync("docker", ["logs", "led-control-lab-vault"], { encoding: "utf8" });
  const firstStartInspect = firstStart.status === 0
    ? ""
    : spawnSync("docker", ["inspect", "led-control-lab-vault", "--format", "{{json .Mounts}} {{json .Config.Cmd}}"], { encoding: "utf8" });
  const generatedConfig = await readFile(path.join(root, ".local", "lab-vault", "config.hcl"), "utf8");
  assert.equal(firstStart.status, 0, JSON.stringify({
    scriptStderr: firstStart.stderr,
    dockerStdout: firstStartLogs.stdout,
    dockerStderr: firstStartLogs.stderr,
    dockerInspectStdout: firstStartInspect.stdout,
    dockerInspectStderr: firstStartInspect.stderr,
    generatedConfig,
    root
  }));
  const rootToken = (await readFile(path.join(root, ".local", "lab-vault", "root-token"), "utf8")).trim();
  const unsealKey = (await readFile(path.join(root, ".local", "lab-vault", "unseal-key"), "utf8")).trim();
  assert.equal((firstStart.stdout + firstStart.stderr).includes(rootToken), false);
  assert.equal((firstStart.stdout + firstStart.stderr).includes(unsealKey), false);

  const stopped = invoke(["stop"]);
  assert.equal(stopped.status, 0, stopped.stderr);
  const restarted = invoke(["start"]);
  assert.equal(restarted.status, 0, restarted.stderr);
  const status = invoke(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Sealed\s+false/);
});
