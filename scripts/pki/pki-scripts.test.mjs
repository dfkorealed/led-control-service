import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const root = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const bootstrap = join(root, "scripts", "pki", "bootstrap-lab-vault.sh");
const issue = join(root, "scripts", "pki", "issue-lab-service-cert.sh");

function temporaryDirectory() {
  return realpathSync(mkdtempSync(join(tmpdir(), "led-pki-test-")));
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
  return { crl, ca: join(caDirectory, "ca.crt"), caKey: join(caDirectory, "ca.key") };
}

function writeMockVault(directory, crlMaterial = {}, storageType = "inmem") {
  const crlPath = typeof crlMaterial === "string" ? crlMaterial : crlMaterial.crl ?? "";
  const caPath = typeof crlMaterial === "string" ? "" : crlMaterial.ca ?? "";
  const caKeyPath = typeof crlMaterial === "string" ? "" : crlMaterial.caKey ?? "";
  const executable = join(directory, "vault");
  writeFileSync(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${directory}/vault.log"
if [[ "$1" == "list" ]]; then
  printf '%s\\n' '["issuer"]'
elif [[ "$1" == "status" ]]; then
  printf '%s\\n' '{"storage_type":"${storageType}"}'
elif [[ "$1 $2" == "read -field=certificate" ]]; then
  if [[ -n "${caPath}" ]]; then cat "${caPath}"; else printf '%s\\n' '-----BEGIN CERTIFICATE-----' 'INTERMEDIATE' '-----END CERTIFICATE-----'; fi
elif [[ "$1 $2" == "read -format=raw" ]]; then
  [[ "\${LAB_TEST_FAIL_CRL:-0}" != 1 ]] || exit 44
  cat "${crlPath}"
elif [[ "$1 $2" == "write -field=certificate" ]]; then
  csr=''
  for argument in "$@"; do [[ "$argument" == csr=@* ]] && csr="\${argument#csr=@}"; done
  openssl x509 -req -in "$csr" -CA "${caPath}" -CAkey "${caKeyPath}" -set_serial "$RANDOM" -days 1
elif [[ "$1 $2" == "write -field=csr" ]]; then
  printf '%s\\n' '-----BEGIN CERTIFICATE REQUEST-----' 'CSR' '-----END CERTIFICATE REQUEST-----'
fi
`
  );
  chmodSync(executable, 0o755);
  return executable;
}

function matchesVaultGlob(pattern, value) {
  const expression = [...pattern].map((character) => {
    if (character === "*") return ".*";
    if (character === "?") return ".";
    return character.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
  }).join("");
  return new RegExp(`^${expression}$`).test(value);
}

test("production Vault scripts accept only raft or consul status storage and lab remains permissive", () => {
  const directory = temporaryDirectory();
  try {
    const baseEnvironment = {
      VAULT_ADDR: "https://vault.internal:8200",
      PKI_ENV: "production",
      VAULT_STORAGE_MODE: "raft"
    };

    for (const script of [bootstrap, issue]) {
      for (const storageType of ["", "unknown", "file", "inmem", "dev"]) {
        const vault = writeMockVault(directory, "", storageType);
        const output = runFailure(script, script === bootstrap ? ["prepare"] : [], {
          ...baseEnvironment,
          VAULT_BIN: vault,
          LAB_API_DNS: "api.lan",
          LAB_API_IP: "192.168.1.10",
          LAB_MQTT_DNS: "mqtt.lan",
          LAB_MQTT_IP: "192.168.1.11"
        });
        assert.match(output, /approved storage backend/i);
      }
    }

    for (const storageType of ["raft", "consul"]) {
      const vault = writeMockVault(directory, "", storageType);
      run(bootstrap, ["prepare"], { ...baseEnvironment, VAULT_BIN: vault });
    }

    const labVault = writeMockVault(directory, "", "file");
    run(bootstrap, ["prepare"], {
      VAULT_BIN: labVault,
      VAULT_ADDR: "http://vault.internal:8200",
      PKI_ENV: "lab",
      VAULT_STORAGE_MODE: "file"
    });

    const httpVault = writeMockVault(directory);
    const httpOutput = runFailure(bootstrap, ["prepare"], {
      VAULT_BIN: httpVault,
      VAULT_ADDR: "http://vault.internal:8200",
      PKI_ENV: "production",
      VAULT_STORAGE_MODE: "raft"
    });
    assert.match(httpOutput, /HTTPS/i);

    const devOutput = runFailure(bootstrap, ["prepare"], {
      VAULT_BIN: httpVault,
      VAULT_ADDR: "https://vault.internal:8200",
      PKI_ENV: "production",
      VAULT_STORAGE_MODE: "inmem"
    });
    assert.match(devOutput, /dev|inmem/i);
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
    const gatewayRole = log.match(/gateway-mqtt-pki\/roles\/gateway-mqtt[^\n]*/)?.[0] ?? "";
    const gatewayUuidGlob = "????????-????-????-????-????????????";
    assert.match(gatewayRole, /allow_any_name=false/);
    assert.match(gatewayRole, new RegExp(`allowed_domains=${gatewayUuidGlob.replace(/\?/g, "\\?")}`));
    assert.match(gatewayRole, /allow_bare_domains=true.*allow_subdomains=false.*allow_glob_domains=true.*allow_wildcard_certificates=false/);
    assert.match(gatewayRole, /allowed_uri_sans=urn:dfkorea:gateway:\*/);
    assert.equal(matchesVaultGlob(gatewayUuidGlob, "550e8400-e29b-41d4-a716-446655440000"), true);
    assert.equal(matchesVaultGlob(gatewayUuidGlob, "api-service"), false);
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
    const current = join(output, "current");
    assert.match(log, /api-server-pki\/sign\/api-server.*common_name=api\.lan.*alt_names=api\.lan.*ip_sans=192\.168\.1\.10/);
    assert.match(log, /gateway-mqtt-pki\/sign\/mqtt-server.*common_name=mqtt\.lan.*alt_names=mqtt\.lan.*ip_sans=192\.168\.1\.11/);
    assert.match(log, /gateway-mqtt-pki\/sign\/api-mqtt-client.*common_name=api-service.*uri_sans=spiffe:\/\/led-control\/mqtt\/api-service/);
    for (const name of ["api", "mqtt-server", "api-mqtt-client"]) {
      assert.equal(mode(join(current, `${name}.key`)), 0o600);
      assert.equal(mode(join(current, `${name}.crt`)), 0o644);
      assert.equal(mode(join(current, `${name}.chain.crt`)), 0o644);
      assert.equal(mode(join(current, `${name}.csr`)), 0o600);
    }
    for (const name of ["api-ca", "mqtt-ca", "device-ca"]) {
      assert.equal(mode(join(current, `${name}.crt`)), 0o644);
      assert.match(readFileSync(join(current, `${name}.crt`), "utf8"), /BEGIN CERTIFICATE/);
    }
    assert.equal(mode(join(current, "mqtt-client.crl")), 0o644);
    assert.match(readFileSync(join(current, "mqtt-client.crl"), "utf8"), /BEGIN X509 CRL/);
    assert.equal(mode(join(current, "device.crl")), 0o644);
    assert.match(readFileSync(join(current, "device.crl"), "utf8"), /BEGIN X509 CRL/);
    assert.match(log, /read -format=raw gateway-mqtt-pki\/crl\/pem/);
    assert.match(log, /read -format=raw gateway-device-pki\/crl\/pem/);
    assert.doesNotMatch(stdout, /token|BEGIN .*PRIVATE KEY/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service bundle은 동일 SAN 재실행에 멱등이고 CRL 실패 시 기존 generation을 보존한다", () => {
  const directory = temporaryDirectory();
  const vault = writeMockVault(directory, createValidCrl(directory));
  const output = join(directory, "bundle");
  const environment = {
    VAULT_BIN: vault,
    VAULT_ADDR: "https://vault.internal:8200",
    LAB_API_DNS: "api.lan",
    LAB_API_IP: "192.168.1.10",
    LAB_MQTT_DNS: "mqtt.lan",
    LAB_MQTT_IP: "192.168.1.11",
    PKI_SERVICE_CERT_DIR: output
  };
  try {
    run(issue, [], environment);
    const firstTarget = readlinkSync(join(output, "current"));
    const firstLog = readFileSync(join(directory, "vault.log"), "utf8");
    const firstSignCount = (firstLog.match(/write -field=certificate/g) ?? []).length;

    run(issue, [], environment);
    assert.equal(readlinkSync(join(output, "current")), firstTarget);
    const secondLog = readFileSync(join(directory, "vault.log"), "utf8");
    assert.equal((secondLog.match(/write -field=certificate/g) ?? []).length, firstSignCount);

    const failure = runFailure(issue, [], { ...environment, LAB_TEST_FAIL_CRL: "1" });
    assert.match(failure, /CRL|crl|failed|실패/i);
    assert.equal(readlinkSync(join(output, "current")), firstTarget);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("standalone service issuer는 OUTPUT_ROOT ancestor symlink를 Vault 호출과 파일 생성 전에 거부한다", () => {
  const directory = temporaryDirectory();
  const outside = temporaryDirectory();
  const link = join(directory, "linked-output");
  symlinkSync(outside, link);
  const vault = writeMockVault(directory, createValidCrl(directory));
  try {
    const failure = runFailure(issue, [], {
      VAULT_BIN: vault, VAULT_ADDR: "https://vault.internal:8200",
      LAB_API_DNS: "api.lan", LAB_API_IP: "192.168.1.10",
      LAB_MQTT_DNS: "mqtt.lan", LAB_MQTT_IP: "192.168.1.11",
      PKI_SERVICE_CERT_DIR: join(link, "bundle")
    });

    assert.match(failure, /symlink/);
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(readdirSync(directory).includes("vault.log"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
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
