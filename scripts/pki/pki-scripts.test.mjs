import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const root = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const bootstrap = join(root, "scripts", "pki", "bootstrap-lab-vault.sh");
const issue = join(root, "scripts", "pki", "issue-lab-service-cert.sh");

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "led-pki-test-"));
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function run(script, args, environment) {
  return execFileSync(script, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runFailure(script, args, environment) {
  try {
    run(script, args, environment);
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.fail(`${script} unexpectedly succeeded`);
}

function createValidCrl(directory) {
  const caDirectory = join(directory, "crl-ca");
  mkdirSync(join(caDirectory, "newcerts"), { recursive: true });
  writeFileSync(join(caDirectory, "index.txt"), "");
  writeFileSync(join(caDirectory, "serial"), "1000\n");
  writeFileSync(join(caDirectory, "crlnumber"), "1000\n");
  execFileSync("openssl", ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", join(caDirectory, "ca.key")]);
  execFileSync("openssl", ["req", "-x509", "-new", "-key", join(caDirectory, "ca.key"), "-out", join(caDirectory, "ca.crt"), "-days", "1", "-subj", "/CN=test-ca"]);
  writeFileSync(join(caDirectory, "openssl.cnf"), [
    "[ ca ]", "default_ca = test_ca", "[ test_ca ]", "database = " + join(caDirectory, "index.txt"),
    "new_certs_dir = " + join(caDirectory, "newcerts"), "certificate = " + join(caDirectory, "ca.crt"),
    "private_key = " + join(caDirectory, "ca.key"), "serial = " + join(caDirectory, "serial"),
    "crlnumber = " + join(caDirectory, "crlnumber"), "default_md = sha256", "default_days = 1",
    "default_crl_days = 1", ""
  ].join("\n"));
  const crl = join(caDirectory, "mqtt-client.crl");
  execFileSync("openssl", ["ca", "-config", join(caDirectory, "openssl.cnf"), "-gencrl", "-out", crl], { stdio: "ignore" });
  return crl;
}

function writeMockVault(directory, crlPath = "") {
  const executable = join(directory, "vault");
  writeFileSync(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${directory}/vault.log"
if [[ "$1" == "list" ]]; then
  printf '%s\\n' '["issuer"]'
elif [[ "$1" == "status" ]]; then
  printf '%s\\n' '{"storage_type":"inmem"}'
elif [[ "$1 $2" == "read -field=certificate" ]]; then
  printf '%s\\n' '-----BEGIN CERTIFICATE-----' 'INTERMEDIATE' '-----END CERTIFICATE-----'
elif [[ "$1 $2" == "read -format=raw" ]]; then
  cat "${crlPath}"
elif [[ "$1 $2" == "write -field=certificate" ]]; then
  printf '%s\\n' '-----BEGIN CERTIFICATE-----' 'LEAF' '-----END CERTIFICATE-----'
elif [[ "$1 $2" == "write -field=csr" ]]; then
  printf '%s\\n' '-----BEGIN CERTIFICATE REQUEST-----' 'CSR' '-----END CERTIFICATE REQUEST-----'
fi
`
  );
  chmodSync(executable, 0o755);
  return executable;
}

test("bootstrap script rejects production HTTP and development storage modes", () => {
  const directory = temporaryDirectory();
  const vault = writeMockVault(directory);
  try {
    const httpOutput = runFailure(bootstrap, ["prepare"], {
      VAULT_BIN: vault,
      VAULT_ADDR: "http://vault.internal:8200",
      PKI_ENV: "production",
      VAULT_STORAGE_MODE: "raft"
    });
    assert.match(httpOutput, /HTTPS/i);

    const devOutput = runFailure(bootstrap, ["prepare"], {
      VAULT_BIN: vault,
      VAULT_ADDR: "https://vault.internal:8200",
      PKI_ENV: "production",
      VAULT_STORAGE_MODE: "inmem"
    });
    assert.match(devOutput, /dev|inmem/i);

    const statusOutput = runFailure(bootstrap, ["prepare"], {
      VAULT_BIN: vault,
      VAULT_ADDR: "https://vault.internal:8200",
      PKI_ENV: "production",
      VAULT_STORAGE_MODE: "raft"
    });
    assert.match(statusOutput, /dev|inmem/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bootstrap prepare creates only purpose CSR artifacts with Vault-generated ECDSA keys", () => {
  const directory = temporaryDirectory();
  const vault = writeMockVault(directory);
  const output = join(directory, "csrs");
  try {
    const stdout = run(bootstrap, ["prepare"], {
      VAULT_BIN: vault,
      VAULT_ADDR: "https://vault.internal:8200",
      PKI_ENV: "lab",
      VAULT_STORAGE_MODE: "file",
      PKI_CSR_DIR: output
    });
    const log = readFileSync(join(directory, "vault.log"), "utf8");
    assert.match(log, /secrets enable -path=gateway-device-pki pki/);
    assert.match(log, /secrets enable -path=gateway-mqtt-pki pki/);
    assert.match(log, /secrets enable -path=api-server-pki pki/);
    assert.match(log, /intermediate\/generate\/internal.*key_type=ec.*key_bits=256/);
    for (const purpose of ["gateway-device", "gateway-mqtt", "api-server"]) {
      assert.match(readFileSync(join(output, `${purpose}-intermediate.csr`), "utf8"), /BEGIN CERTIFICATE REQUEST/);
      assert.equal(mode(join(output, `${purpose}-intermediate.csr`)), 0o644);
    }
    assert.doesNotMatch(stdout, /token|BEGIN .*PRIVATE KEY/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bootstrap install imports externally signed intermediates and configures isolated least-privilege roles", () => {
  const directory = temporaryDirectory();
  const vault = writeMockVault(directory);
  const intermediates = join(directory, "intermediates");
  try {
    writeFileSync(join(directory, "gateway-device.crt"), "device intermediate\n");
    writeFileSync(join(directory, "gateway-mqtt.crt"), "mqtt intermediate\n");
    writeFileSync(join(directory, "api-server.crt"), "api intermediate\n");
    run(bootstrap, ["install"], {
      VAULT_BIN: vault,
      VAULT_ADDR: "https://vault.internal:8200",
      PKI_ENV: "lab",
      VAULT_STORAGE_MODE: "file",
      GATEWAY_DEVICE_INTERMEDIATE_CERT: join(directory, "gateway-device.crt"),
      GATEWAY_MQTT_INTERMEDIATE_CERT: join(directory, "gateway-mqtt.crt"),
      API_SERVER_INTERMEDIATE_CERT: join(directory, "api-server.crt"),
      PKI_INTERMEDIATE_DIR: intermediates
    });
    const log = readFileSync(join(directory, "vault.log"), "utf8");
    assert.match(log, /gateway-device-pki\/intermediate\/set-signed/);
    assert.match(log, /gateway-mqtt-pki\/intermediate\/set-signed/);
    assert.match(log, /api-server-pki\/intermediate\/set-signed/);
    assert.match(log, /gateway-device-pki\/roles\/gateway-device.*client_flag=true.*server_flag=false.*max_ttl=8760h/);
    assert.match(log, /gateway-mqtt-pki\/roles\/gateway-mqtt.*client_flag=true.*server_flag=false.*max_ttl=2160h/);
    assert.match(log, /gateway-mqtt-pki\/roles\/mqtt-server.*client_flag=false.*server_flag=true/);
    assert.match(log, /gateway-mqtt-pki\/roles\/api-mqtt-client.*allowed_domains=api-service.*allow_bare_domains=true.*client_flag=true.*server_flag=false/);
    assert.match(log, /api-server-pki\/roles\/api-server.*client_flag=false.*server_flag=true/);
    assert.match(log, /policy write gateway-pki/);
    assert.equal(mode(join(intermediates, "gateway-device-ca.v1.crt")), 0o644);
    assert.equal(mode(join(intermediates, "gateway-mqtt-ca.v1.crt")), 0o644);
    assert.equal(mode(join(intermediates, "api-server-ca.v1.crt")), 0o644);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service issuance requires every SAN input and publishes separate API, MQTT, and API MQTT client credentials", () => {
  const directory = temporaryDirectory();
  const vault = writeMockVault(directory, createValidCrl(directory));
  const output = join(directory, "bundle");
  try {
    const missingSan = runFailure(issue, [], {
      VAULT_BIN: vault,
      VAULT_ADDR: "https://vault.internal:8200",
      LAB_API_DNS: "api.lan",
      LAB_API_IP: "192.168.1.10",
      LAB_MQTT_DNS: "mqtt.lan"
    });
    assert.match(missingSan, /LAB_MQTT_IP is required/);

    const stdout = run(issue, [], {
      VAULT_BIN: vault,
      VAULT_ADDR: "https://vault.internal:8200",
      LAB_API_DNS: "api.lan",
      LAB_API_IP: "192.168.1.10",
      LAB_MQTT_DNS: "mqtt.lan",
      LAB_MQTT_IP: "192.168.1.11",
      PKI_SERVICE_CERT_DIR: output
    });
    const log = readFileSync(join(directory, "vault.log"), "utf8");
    assert.match(log, /api-server-pki\/sign\/api-server.*common_name=api\.lan.*alt_names=api\.lan.*ip_sans=192\.168\.1\.10/);
    assert.match(log, /gateway-mqtt-pki\/sign\/mqtt-server.*common_name=mqtt\.lan.*alt_names=mqtt\.lan.*ip_sans=192\.168\.1\.11/);
    assert.match(log, /gateway-mqtt-pki\/sign\/api-mqtt-client.*common_name=api-service.*uri_sans=spiffe:\/\/led-control\/mqtt\/api-service/);
    for (const name of ["api", "mqtt-server", "api-mqtt-client"]) {
      assert.equal(mode(join(output, `${name}.key`)), 0o600);
      assert.equal(mode(join(output, `${name}.crt`)), 0o644);
      assert.equal(mode(join(output, `${name}.chain.crt`)), 0o644);
      assert.equal(mode(join(output, `${name}.csr`)), 0o600);
    }
    for (const name of ["api-ca", "mqtt-ca"]) {
      assert.equal(mode(join(output, `${name}.v1.crt`)), 0o644);
      assert.equal(mode(join(output, `${name}.crt`)), 0o644);
      assert.match(readFileSync(join(output, `${name}.crt`), "utf8"), /BEGIN CERTIFICATE/);
    }
    assert.equal(mode(join(output, "mqtt-client.crl")), 0o644);
    assert.match(readFileSync(join(output, "mqtt-client.crl"), "utf8"), /BEGIN X509 CRL/);
    assert.match(log, /read -format=raw gateway-mqtt-pki\/crl\/pem/);
    assert.doesNotMatch(stdout, /token|BEGIN .*PRIVATE KEY/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scripts and policy never create or print Root or CA private keys", () => {
  const sources = [bootstrap, issue, join(root, "infra", "vault", "policies", "gateway-pki.hcl")]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  assert.doesNotMatch(sources, /(?:ROOT|CA)_(?:PRIVATE_)?KEY\s*=/);
  assert.doesNotMatch(sources, /cat\s+.*(?:token|\.key)|printenv\s+.*TOKEN/i);
  const policy = readFileSync(join(root, "infra", "vault", "policies", "gateway-pki.hcl"), "utf8");
  assert.match(policy, /gateway-device-pki\/revoke/);
  assert.match(policy, /gateway-mqtt-pki\/revoke/);
  assert.match(policy, /gateway-device-pki\/crl\/pem/);
  assert.doesNotMatch(policy, /sign\/(?:mqtt-server|api-mqtt-client|api-server)/);
});
