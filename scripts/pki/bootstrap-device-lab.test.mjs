import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:https";
import test from "node:test";

const root = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const orchestrator = join(root, "scripts", "pki", "bootstrap-device-lab.sh");
const stationIssuer = join(root, "scripts", "pki", "issue-lab-manufacturing-station.sh");

function mode(path) {
  return statSync(path).mode & 0o777;
}

function makeSandbox() {
  const directory = mkdtempSync(join(tmpdir(), "led-device-lab-"));
  const scriptDirectory = join(directory, "scripts", "pki");
  const bin = join(directory, "bin");
  const log = join(directory, "calls.log");
  mkdirSync(scriptDirectory, { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (existsSync(orchestrator)) {
    copyFileSync(orchestrator, join(scriptDirectory, "bootstrap-device-lab.sh"));
    chmodSync(join(scriptDirectory, "bootstrap-device-lab.sh"), 0o755);
  }
  for (const [name, body] of Object.entries({
    "lab-vault.sh": 'echo vault-start >> "$LAB_TEST_LOG"',
    "bootstrap-lab-vault.sh": 'echo "vault-$1" >> "$LAB_TEST_LOG"',
    "sign-lab-intermediates.sh": 'echo sign >> "$LAB_TEST_LOG"',
    "issue-lab-service-cert.sh": `
echo service >> "$LAB_TEST_LOG"
[[ "${'${LAB_TEST_FAIL_SERVICE:-0}'}" != 1 ]] || exit 42
mkdir -p "$PKI_SERVICE_CERT_DIR"
generation="$PKI_SERVICE_CERT_DIR/generations/bundle-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
mkdir -p "$generation"
ln -s generations/bundle-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$PKI_SERVICE_CERT_DIR/current"
for name in api.crt api.chain.crt mqtt-server.crt mqtt-ca.crt api-ca.crt device-ca.crt; do printf '%s\n' certificate > "$generation/$name"; chmod 0644 "$generation/$name"; done
for name in api.key mqtt-server.key api-mqtt-client.key; do printf '%s\n' private > "$generation/$name"; chmod 0600 "$generation/$name"; done
printf '%s\n' certificate > "$generation/api-mqtt-client.crt"; chmod 0644 "$generation/api-mqtt-client.crt"
for name in device.crl mqtt-client.crl; do printf '%s\n' crl > "$generation/$name"; chmod 0644 "$generation/$name"; done`,
    "issue-lab-manufacturing-station.sh": `
echo station >> "$LAB_TEST_LOG"
mkdir -p "$LAB_MANUFACTURING_DIR"
for name in manufacturing-ca.crt station.crt manufacturing.crl; do printf '%s\n' certificate > "$LAB_MANUFACTURING_DIR/$name"; chmod 0644 "$LAB_MANUFACTURING_DIR/$name"; done
printf '%s\n' private > "$LAB_MANUFACTURING_DIR/station.key"; chmod 0600 "$LAB_MANUFACTURING_DIR/station.key"`
  })) {
    const path = join(scriptDirectory, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const vault = join(bin, "vault");
  writeFileSync(vault, `#!/usr/bin/env bash
set -euo pipefail
echo "vault-cli $*" >> "$LAB_TEST_LOG"
if [[ "$1 $2" == "token create" ]]; then
  count_file="$LAB_TEST_LOG.token-count"
  count=0; [[ ! -f "$count_file" ]] || count="$(cat "$count_file")"
  count=$((count + 1)); printf '%s\n' "$count" > "$count_file"
  renewable=true; [[ "\${LAB_TEST_TOKEN_PROFILE_INVALID:-0}" != 1 ]] || renewable=false
  printf '{"auth":{"client_token":"policy-token-%s","accessor":"policy-accessor-%s","lease_duration":86400,"renewable":%s,"policies":["gateway-pki"]}}\n' "$count" "$count" "$renewable"
  exit 0
fi
if [[ "$1 $2" == "token revoke" && ",\${LAB_TEST_FAIL_REVOKE_ACCESSORS:-\${LAB_TEST_FAIL_REVOKE_ACCESSOR:-}}," == *",\${4:-},"* ]]; then exit 42; fi
exit 0
`);
  chmodSync(vault, 0o755);
  const node = join(bin, "node");
  writeFileSync(node, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${LAB_TEST_FAIL_PUBLISH:-0}" == 1 && "\${1:-}" == -e && "\${2:-}" == *renameSync* ]]; then exit 43; fi
exec "$LAB_TEST_REAL_NODE" "$@"
`);
  chmodSync(node, 0o755);
  return { directory, bin, log, script: join(scriptDirectory, "bootstrap-device-lab.sh") };
}

function run(fixture, overrides = {}) {
  return spawnSync("/bin/bash", [fixture.script], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      LAB_TEST_REAL_NODE: process.execPath,
      PKI_ENV: "lab",
      LAB_API_IP: "192.0.2.10",
      LAB_MQTT_IP: "192.0.2.10",
      LAB_TEST_LOG: fixture.log,
      VAULT_BIN: join(fixture.bin, "vault"),
      LAB_MANUFACTURING_DIR: join(fixture.directory, ".local", "lab-pki", "manufacturing"),
      ...overrides
    }
  });
}

test("비-Lab 환경과 누락된 필수 도구를 변경 전에 거부한다", () => {
  const fixture = makeSandbox();
  try {
    const production = run(fixture, { PKI_ENV: "production" });
    assert.equal(production.status, 1);
    assert.match(production.stderr, /PKI_ENV=lab/);
    assert.equal(existsSync(fixture.log), false);

    const missingVault = run(fixture, { VAULT_BIN: join(fixture.directory, "missing-vault") });
    assert.equal(missingVault.status, 1);
    assert.match(missingVault.stderr, /Vault|vault/);
    assert.equal(existsSync(fixture.log), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Lab PKI 경계 또는 하위 경로의 symlink를 첫 부작용 전에 거부한다", () => {
  for (const relativePath of [".local/lab-pki", ".local/lab-pki/services", ".local/lab-pki/manufacturing"]) {
    const fixture = makeSandbox();
    const outside = mkdtempSync(join(tmpdir(), "led-device-lab-outside-"));
    try {
      mkdirSync(join(fixture.directory, ".local", "lab-vault"), { recursive: true });
      writeFileSync(join(fixture.directory, ".local", "lab-vault", "root-token"), "root-token\n", { mode: 0o600 });
      const target = join(fixture.directory, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(outside, target);

      const result = run(fixture);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /symlink|경계|안전/);
      assert.equal(existsSync(fixture.log), false);
      assert.deepEqual(readFileNames(outside), []);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("Vault bootstrap 순서와 제한 token, CRL, 절대 경로 lab.env를 생성한다", () => {
  const fixture = makeSandbox();
  try {
    mkdirSync(join(fixture.directory, ".local", "lab-vault"), { recursive: true });
    writeFileSync(join(fixture.directory, ".local", "lab-vault", "root-token"), "root-token-must-not-leak\n", { mode: 0o600 });
    const result = run(fixture, { LAB_API_DNS: "api.led.lan", LAB_MQTT_DNS: "mqtt.led.lan" });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(fixture.log, "utf8").trim().split("\n");
    assert.deepEqual(calls.slice(0, 6), ["vault-start", "vault-prepare", "sign", "vault-install", "service", "station"]);
    assert.match(calls.at(-1), /vault-cli token create .*policy=gateway-pki/);

    const pki = join(fixture.directory, ".local", "lab-pki");
    const envPath = join(pki, "lab.env");
    const tokenPath = join(pki, "application", "current", "token");
    const env = readFileSync(envPath, "utf8");
    assert.equal(mode(envPath), 0o600);
    assert.equal(mode(tokenPath), 0o600);
    assert.equal(readFileSync(tokenPath, "utf8").trim(), "policy-token-1");
    assert.doesNotMatch(env, /root-token-must-not-leak|root-token$/m);
    const configuredTokenPath = /^VAULT_TOKEN_FILE="([^"]+)"$/m.exec(env)?.[1];
    assert.ok(configuredTokenPath?.startsWith("/"));
    assert.equal(readFileSync(configuredTokenPath, "utf8").trim(), "policy-token-1");
    assert.match(env, /VAULT_PKI_DEVICE_MOUNT="gateway-device-pki"/);
    assert.match(env, /MQTT_URL="mqtts:\/\/mqtt\.led\.lan:8883"/);
    assert.match(env, /VITE_API_PROXY_TARGET="https:\/\/api\.led\.lan:4000"/);
    assert.match(env, /NODE_EXTRA_CA_CERTS="[^"]+\/services\/current\/api-ca\.crt"/);
    for (const name of ["device.crl", "mqtt-client.crl"]) assert.equal(existsSync(join(pki, "services", "current", name)), true);
    assert.equal(existsSync(join(pki, "manufacturing", "manufacturing.crl")), true);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("재실행은 이전 application token을 폐기한 뒤 periodic token generation을 원자 교체한다", () => {
  const fixture = makeSandbox();
  try {
    const pki = join(fixture.directory, ".local", "lab-pki");
    mkdirSync(join(fixture.directory, ".local", "lab-vault"), { recursive: true });
    writeFileSync(join(fixture.directory, ".local", "lab-vault", "root-token"), "root-token\n", { mode: 0o600 });
    mkdirSync(pki, { recursive: true });
    const old = join(pki, "application", "generations", "token-old");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "token"), "old-token\n", { mode: 0o600 });
    writeFileSync(join(old, "accessor"), "old-accessor\n", { mode: 0o600 });
    symlinkSync("generations/token-old", join(pki, "application", "current"));

    const result = run(fixture);

    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(fixture.log, "utf8");
    assert.match(calls, /token create .*orphan.*no-default-policy.*period=24h/);
    assert.doesNotMatch(calls, /ttl=0/);
    assert.match(calls, /token revoke -accessor old-accessor/);
    assert.equal(readFileSync(join(pki, "application", "current", "accessor"), "utf8").trim(), "policy-accessor-1");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("이전 token revoke 실패 시 새 token을 보상 폐기하고 기존 generation과 env를 보존한다", () => {
  const fixture = makeSandbox();
  try {
    const pki = join(fixture.directory, ".local", "lab-pki");
    const old = join(pki, "application", "generations", "token-old");
    mkdirSync(join(fixture.directory, ".local", "lab-vault"), { recursive: true });
    writeFileSync(join(fixture.directory, ".local", "lab-vault", "root-token"), "root-token\n", { mode: 0o600 });
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "token"), "old-token\n", { mode: 0o600 });
    writeFileSync(join(old, "accessor"), "old-accessor\n", { mode: 0o600 });
    symlinkSync("generations/token-old", join(pki, "application", "current"));
    writeFileSync(join(pki, "lab.env"), "EXISTING=1\n", { mode: 0o600 });

    const result = run(fixture, { LAB_TEST_FAIL_REVOKE_ACCESSOR: "old-accessor" });

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(pki, "application", "current", "token"), "utf8"), "old-token\n");
    assert.equal(readFileSync(join(pki, "lab.env"), "utf8"), "EXISTING=1\n");
    const calls = readFileSync(fixture.log, "utf8");
    assert.match(calls, /token revoke -accessor old-accessor/);
    assert.match(calls, /token revoke -accessor policy-accessor-1/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("새 token 정리 revoke도 실패하면 각 실패 단계의 token을 orphan 복구 큐에 보존한다", () => {
  for (const scenario of ["profile", "previous-revoke", "publish"]) {
    const fixture = makeSandbox();
    try {
      const pki = join(fixture.directory, ".local", "lab-pki");
      prepareRootToken(fixture);
      const overrides = { LAB_TEST_FAIL_REVOKE_ACCESSORS: "policy-accessor-1" };
      if (scenario === "profile") overrides.LAB_TEST_TOKEN_PROFILE_INVALID = "1";
      if (scenario === "publish") overrides.LAB_TEST_FAIL_PUBLISH = "1";
      if (scenario === "previous-revoke") {
        const old = join(pki, "application", "generations", "token-old");
        mkdirSync(old, { recursive: true });
        writeFileSync(join(old, "token"), "old-token\n", { mode: 0o600 });
        writeFileSync(join(old, "accessor"), "old-accessor\n", { mode: 0o600 });
        symlinkSync("generations/token-old", join(pki, "application", "current"));
        overrides.LAB_TEST_FAIL_REVOKE_ACCESSORS = "old-accessor,policy-accessor-1";
      }

      const result = run(fixture, overrides);
      assert.notEqual(result.status, 0);
      const orphanRoot = join(pki, "application-tokens", "orphaned");
      const entries = readdirSync(orphanRoot);
      assert.equal(entries.length, 1);
      const orphan = join(orphanRoot, entries[0]);
      assert.equal(mode(orphanRoot), 0o700);
      assert.equal(mode(orphan), 0o700);
      assert.equal(mode(join(orphan, "token")), 0o600);
      assert.equal(mode(join(orphan, "accessor")), 0o600);
      assert.equal(readFileSync(join(orphan, "token"), "utf8").trim(), "policy-token-1");
      assert.equal(readFileSync(join(orphan, "accessor"), "utf8").trim(), "policy-accessor-1");
      assert.doesNotMatch(result.stdout + "\n" + result.stderr, /policy-token-1|policy-accessor-1/);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("재실행은 orphan accessor를 먼저 reconcile하고 성공한 항목만 제거한다", () => {
  const fixture = makeSandbox();
  try {
    const pki = join(fixture.directory, ".local", "lab-pki");
    const orphanRoot = join(pki, "application-tokens", "orphaned");
    prepareRootToken(fixture);
    for (const [name, accessor] of [["one", "orphan-one"], ["two", "orphan-two"]]) {
      const orphan = join(orphanRoot, name);
      mkdirSync(orphan, { recursive: true, mode: 0o700 });
      writeFileSync(join(orphan, "token"), "token-" + name + "\n", { mode: 0o600 });
      writeFileSync(join(orphan, "accessor"), accessor + "\n", { mode: 0o600 });
    }

    const first = run(fixture, { LAB_TEST_FAIL_REVOKE_ACCESSORS: "orphan-two" });
    assert.notEqual(first.status, 0);
    assert.equal(existsSync(join(orphanRoot, "one")), false);
    assert.equal(existsSync(join(orphanRoot, "two")), true);
    assert.doesNotMatch(readFileSync(fixture.log, "utf8"), /token create/);

    const second = run(fixture);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readdirSync(orphanRoot), []);
    const calls = readFileSync(fixture.log, "utf8");
    assert.ok(calls.lastIndexOf("token revoke -accessor orphan-two") < calls.lastIndexOf("vault-prepare"));
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function prepareRootToken(fixture) {
  mkdirSync(join(fixture.directory, ".local", "lab-vault"), { recursive: true });
  writeFileSync(join(fixture.directory, ".local", "lab-vault", "root-token"), "root-token\n", { mode: 0o600 });
}

function readFileNames(directory) {
  return existsSync(directory) ? execFileSync("find", [directory, "-mindepth", "1", "-print"], { encoding: "utf8" }).trim().split("\n").filter(Boolean) : [];
}

test("중간 단계 실패 시 기존 application token과 lab.env를 보존한다", () => {
  const fixture = makeSandbox();
  try {
    const pki = join(fixture.directory, ".local", "lab-pki");
    mkdirSync(join(fixture.directory, ".local", "lab-vault"), { recursive: true });
    writeFileSync(join(fixture.directory, ".local", "lab-vault", "root-token"), "root-token-must-not-leak\n", { mode: 0o600 });
    mkdirSync(pki, { recursive: true });
    writeFileSync(join(pki, "application-token"), "existing-policy-token\n", { mode: 0o600 });
    writeFileSync(join(pki, "lab.env"), "EXISTING_ENV=1\n", { mode: 0o600 });
    const result = run(fixture, { LAB_TEST_FAIL_SERVICE: "1" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(pki, "application-token"), "utf8"), "existing-policy-token\n");
    assert.equal(readFileSync(join(pki, "lab.env"), "utf8"), "EXISTING_ENV=1\n");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function openssl(args, cwd) {
  execFileSync("openssl", args, { cwd, stdio: "pipe" });
}

function issueServerIdentity(directory) {
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "server-ca.key"], directory);
  openssl(["req", "-x509", "-new", "-key", "server-ca.key", "-out", "server-ca.crt", "-days", "1", "-subj", "/CN=Lab API Test CA", "-addext", "basicConstraints=critical,CA:true", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], directory);
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "server.key"], directory);
  openssl(["req", "-new", "-key", "server.key", "-out", "server.csr", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], directory);
  writeFileSync(join(directory, "server.ext"), "basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n");
  openssl(["x509", "-req", "-in", "server.csr", "-CA", "server-ca.crt", "-CAkey", "server-ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "1", "-extfile", "server.ext"], directory);
}

function issueOtherClient(directory) {
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "other-ca.key"], directory);
  openssl(["req", "-x509", "-new", "-key", "other-ca.key", "-out", "other-ca.crt", "-days", "1", "-subj", "/CN=Other CA", "-addext", "basicConstraints=critical,CA:true", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], directory);
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "other.key"], directory);
  openssl(["req", "-new", "-key", "other.key", "-out", "other.csr", "-subj", "/CN=other-station"], directory);
  writeFileSync(join(directory, "other.ext"), "basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n");
  openssl(["x509", "-req", "-in", "other.csr", "-CA", "other-ca.crt", "-CAkey", "other-ca.key", "-CAcreateserial", "-out", "other.crt", "-days", "1", "-extfile", "other.ext"], directory);
}

function callEndpoint(port, directory, cert, key) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "localhost", port, path: "/manufacturing/gateway-enrollments", method: "POST", ca: readFileSync(join(directory, "server-ca.crt")), cert: readFileSync(cert), key: readFileSync(key), rejectUnauthorized: true, agent: new Agent({ maxCachedSessions: 0 }) }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    req.once("error", reject);
    req.end();
  });
}

test("제조 endpoint TLS가 정상 station만 허용하고 타 CA 및 폐기 station을 거부한다", async () => {
  const directory = mkdtempSync(join(tmpdir(), "led-manufacturing-mtls-"));
  const repo = join(directory, "repo");
  const scriptDirectory = join(repo, "scripts", "pki");
  mkdirSync(scriptDirectory, { recursive: true });
  copyFileSync(stationIssuer, join(scriptDirectory, "issue-lab-manufacturing-station.sh"));
  chmodSync(join(scriptDirectory, "issue-lab-manufacturing-station.sh"), 0o755);
  let server;
  try {
    execFileSync(join(scriptDirectory, "issue-lab-manufacturing-station.sh"), ["issue"], { cwd: repo, env: { ...process.env, PKI_ENV: "lab" }, stdio: "pipe" });
    const manufacturing = join(repo, ".local", "lab-pki", "manufacturing");
    issueServerIdentity(directory);
    issueOtherClient(directory);
    const tlsOptions = () => ({ cert: readFileSync(join(directory, "server.crt")), key: readFileSync(join(directory, "server.key")), ca: readFileSync(join(manufacturing, "manufacturing-ca.crt")), crl: readFileSync(join(manufacturing, "manufacturing.crl")), requestCert: true, rejectUnauthorized: true });
    const startServer = async () => {
      server = createServer(tlsOptions(), (req, res) => {
        res.writeHead(req.url === "/manufacturing/gateway-enrollments" ? 204 : 404).end();
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server.address().port;
    };
    const port = await startServer();
    assert.equal(await callEndpoint(port, directory, join(manufacturing, "station.crt"), join(manufacturing, "station.key")), 204);
    await assert.rejects(callEndpoint(port, directory, join(directory, "other.crt"), join(directory, "other.key")));
    execFileSync(join(scriptDirectory, "issue-lab-manufacturing-station.sh"), ["revoke"], { cwd: repo, env: { ...process.env, PKI_ENV: "lab" }, stdio: "pipe" });
    server.setSecureContext(tlsOptions());
    await assert.rejects(callEndpoint(port, directory, join(manufacturing, "station.crt"), join(manufacturing, "station.key")));
  } finally {
    await new Promise((resolve) => server?.close(resolve) ?? resolve());
    rmSync(directory, { recursive: true, force: true });
  }
});
