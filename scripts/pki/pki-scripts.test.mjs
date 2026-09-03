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
  const rootKey = join(caDirectory, "root.key");
  const rootCertificate = join(caDirectory, "root.crt");
  const intermediateKey = join(caDirectory, "ca.key");
  const intermediateCsr = join(caDirectory, "ca.csr");
  const intermediateCertificate = join(caDirectory, "ca.crt");
  execFileSync("openssl", ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", rootKey]);
  execFileSync("openssl", ["req", "-x509", "-new", "-key", rootKey, "-out", rootCertificate, "-days", "1", "-subj", "/CN=test-root", "-addext", "basicConstraints=critical,CA:true,pathlen:1", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  execFileSync("openssl", ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", intermediateKey]);
  execFileSync("openssl", ["req", "-new", "-key", intermediateKey, "-out", intermediateCsr, "-subj", "/CN=test-intermediate"]);
  const intermediateExtensions = join(caDirectory, "intermediate.cnf");
  writeFileSync(intermediateExtensions, ["[ intermediate_ca ]", "basicConstraints=critical,CA:true,pathlen:0", "keyUsage=critical,keyCertSign,cRLSign", "subjectKeyIdentifier=hash", "authorityKeyIdentifier=keyid,issuer", ""].join("\n"));
  execFileSync("openssl", ["x509", "-req", "-in", intermediateCsr, "-CA", rootCertificate, "-CAkey", rootKey, "-CAcreateserial", "-out", intermediateCertificate, "-days", "1", "-extfile", intermediateExtensions, "-extensions", "intermediate_ca"]);
  writeFileSync(join(caDirectory, "openssl.cnf"), [
    "[ ca ]", "default_ca = test_ca", "[ test_ca ]", "database = " + join(caDirectory, "index.txt"),
    "new_certs_dir = " + join(caDirectory, "newcerts"), "certificate = " + intermediateCertificate,
    "private_key = " + intermediateKey, "serial = " + join(caDirectory, "serial"),
    "crlnumber = " + join(caDirectory, "crlnumber"), "default_md = sha256", "default_days = 1",
    "default_crl_days = 1", ""
  ].join("\n"));
  const crl = join(caDirectory, "intermediate.crl");
  execFileSync("openssl", ["ca", "-config", join(caDirectory, "openssl.cnf"), "-gencrl", "-out", crl], { stdio: "ignore" });
  const rootConfig = join(caDirectory, "root-openssl.cnf");
  writeFileSync(rootConfig, [
    "[ ca ]", "default_ca = test_ca", "[ test_ca ]", "database = " + join(caDirectory, "root-index.txt"),
    "new_certs_dir = " + join(caDirectory, "root-newcerts"), "certificate = " + rootCertificate,
    "private_key = " + rootKey, "serial = " + join(caDirectory, "root-serial"),
    "crlnumber = " + join(caDirectory, "root-crlnumber"), "default_md = sha256", "default_crl_days = 1", ""
  ].join("\n"));
  mkdirSync(join(caDirectory, "root-newcerts"));
  writeFileSync(join(caDirectory, "root-index.txt"), "");
  writeFileSync(join(caDirectory, "root-serial"), "1000\n");
  writeFileSync(join(caDirectory, "root-crlnumber"), "1000\n");
  const rootCrl = join(caDirectory, "root.crl");
  execFileSync("openssl", ["ca", "-config", rootConfig, "-gencrl", "-out", rootCrl], { stdio: "ignore" });
  const caChain = join(caDirectory, "ca-chain.crt");
  writeFileSync(caChain, `${readFileSync(intermediateCertificate, "utf8")}\n${readFileSync(rootCertificate, "utf8")}`);
  return { crl, rootCrl, ca: intermediateCertificate, caKey: intermediateKey, caChain };
}

function writeMockVault(directory, crlMaterial = {}, storageType = "inmem") {
  const crlPath = typeof crlMaterial === "string" ? crlMaterial : crlMaterial.crl ?? "";
  const caPath = typeof crlMaterial === "string" ? "" : crlMaterial.ca ?? "";
  const caKeyPath = typeof crlMaterial === "string" ? "" : crlMaterial.caKey ?? "";
  const caChainPath = typeof crlMaterial === "string" ? "" : crlMaterial.caChain ?? "";
  const intermediateKey = join(directory, "mock-intermediate.key");
  const intermediateCsr = join(directory, "mock-intermediate.csr");
  execFileSync("openssl", ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", intermediateKey]);
  execFileSync("openssl", ["req", "-new", "-key", intermediateKey, "-subj", "/CN=Mock Intermediate", "-out", intermediateCsr]);
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
elif [[ "$1 $2" == "read -format=json" && "$3" == */cert/ca_chain ]]; then
  node -e 'const source = require("node:fs").readFileSync(process.argv[1], "utf8"); const ca_chain = process.env.LAB_TEST_CA_CHAIN_AS_STRING === "1" ? source : source.match(/-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----/g); process.stdout.write(JSON.stringify({ data: { certificate: source, ca_chain } }));' "${caChainPath}"
elif [[ "$1 $2" == "read -format=raw" && "$3" == */crl/pem ]]; then
  [[ "\${LAB_TEST_FAIL_CRL:-0}" != 1 ]] || exit 44
  cat "${crlPath}"
elif [[ "$1 $2" == "write -field=certificate" ]]; then
  csr=''
  for argument in "$@"; do [[ "$argument" == csr=@* ]] && csr="\${argument#csr=@}"; done
  openssl x509 -req -in "$csr" -CA "${caPath}" -CAkey "${caKeyPath}" -set_serial "$RANDOM" -days 1
elif [[ "$1 $2" == "write -field=csr" ]]; then
  cat "${intermediateCsr}"
elif [[ "$1 $2" == "write -format=json" && "$3" == */intermediate/set-signed ]]; then
  printf '%s\\n' '{"data":{"imported_issuers":["issuer-with-key","root-without-key"],"mapping":{"issuer-with-key":"key-id","root-without-key":""}}}'
fi
`
  );
  chmodSync(executable, 0o755);
  return executable;
}

function matchesVaultGlob(pattern, value) {
  const expression = [...pattern].map((character) => {
    if (character === "*") return ".*";
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

test("bootstrap prepare replaces an interrupted invalid CSR artifact", () => {
  const directory = temporaryDirectory();
  const vault = writeMockVault(directory);
  const output = join(directory, "csrs");
  try {
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(output, "gateway-device-intermediate.csr"),
      "-----BEGIN CERTIFICATE REQUEST-----\n\n-----END CERTIFICATE REQUEST-----\n"
    );

    run(bootstrap, ["prepare"], {
      VAULT_BIN: vault,
      VAULT_ADDR: "https://vault.internal:8200",
      PKI_ENV: "lab",
      PKI_CSR_DIR: output
    });

    execFileSync("openssl", ["req", "-in", join(output, "gateway-device-intermediate.csr"), "-noout", "-verify"]);
    const log = readFileSync(join(directory, "vault.log"), "utf8");
    assert.match(log, /gateway-device-pki\/intermediate\/generate\/internal/);
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
    assert.match(log, /gateway-device-pki\/config\/issuers default=issuer-with-key/);
    assert.doesNotMatch(log, /config\/issuers default=root-without-key/);
    for (const mount of ["gateway-device-pki", "gateway-mqtt-pki", "api-server-pki"]) {
      assert.match(log, new RegExp(`${mount}\\/config\\/crl.*expiry=72h.*auto_rebuild=true.*auto_rebuild_grace_period=24h`));
      assert.match(log, new RegExp(`read ${mount}\\/crl\\/rotate`));
    }
    assert.match(log, /gateway-device-pki\/roles\/gateway-device.*client_flag=true.*server_flag=false.*max_ttl=8760h/);
    for (const role of ["gateway-device", "gateway-mqtt", "mqtt-server", "api-mqtt-client", "api-server"]) {
      const roleLine = log.split("\n").find((line) => line.includes(`/roles/${role} `)) ?? "";
      assert.match(roleLine, /key_type=ec/);
      assert.match(roleLine, /key_bits=256/);
    }
    const gatewayRole = log.match(/gateway-mqtt-pki\/roles\/gateway-mqtt[^\n]*/)?.[0] ?? "";
    const gatewayUuidGlob = "*-*-4*-*-*";
    assert.match(gatewayRole, /allow_any_name=false/);
    assert.match(gatewayRole, new RegExp(`allowed_domains=${gatewayUuidGlob.replace(/\*/g, "\\*")}`));
    assert.match(gatewayRole, /allow_bare_domains=true.*allow_subdomains=false.*allow_glob_domains=true.*allow_wildcard_certificates=false/);
    assert.match(gatewayRole, /enforce_hostnames=true/);
    assert.match(gatewayRole, /allowed_uri_sans=urn:dfkorea:gateway:\*/);
    assert.equal(matchesVaultGlob(gatewayUuidGlob, "550e8400-e29b-41d4-a716-446655440000"), true);
    assert.equal(matchesVaultGlob(gatewayUuidGlob, "550e8400-e29b-11d4-a716-446655440000"), false);
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

test("service issuance accepts the Vault 1.17 PEM-string CA chain and publishes separate service credentials", () => {
  const directory = temporaryDirectory();
  const crlMaterial = createValidCrl(directory);
  const vault = writeMockVault(directory, crlMaterial);
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
      LAB_TEST_CA_CHAIN_AS_STRING: "1",
      PKI_ROOT_CRL_PATH: crlMaterial.rootCrl,
      PKI_SERVICE_CERT_DIR: output
    });
    const log = readFileSync(join(directory, "vault.log"), "utf8");
    const current = join(output, "current");
    assert.match(log, /api-server-pki\/sign\/api-server.*common_name=api\.lan.*alt_names=api\.lan.*ip_sans=192\.168\.1\.10/);
    assert.match(log, /gateway-mqtt-pki\/sign\/mqtt-server.*common_name=mqtt\.lan.*alt_names=mqtt\.lan.*ip_sans=192\.168\.1\.11/);
    assert.match(log, /gateway-mqtt-pki\/sign\/api-mqtt-client.*common_name=api-service.*uri_sans=spiffe:\/\/led-control\/mqtt\/api-service/);
    for (const mount of ["api-server-pki", "gateway-mqtt-pki", "gateway-device-pki"]) {
      assert.match(log, new RegExp(`read -format=json ${mount}\\/cert\\/ca_chain`));
    }
    for (const name of ["api", "mqtt-server", "api-mqtt-client"]) {
      assert.equal(mode(join(current, `${name}.key`)), 0o600);
      assert.equal(mode(join(current, `${name}.crt`)), 0o644);
      assert.equal(mode(join(current, `${name}.chain.crt`)), 0o644);
      assert.equal(mode(join(current, `${name}.csr`)), 0o600);
    }
    for (const name of ["api-ca", "mqtt-ca", "device-ca"]) {
      assert.equal(mode(join(current, `${name}.crt`)), 0o644);
      assert.equal(readFileSync(join(current, `${name}.crt`), "utf8"), readFileSync(crlMaterial.caChain, "utf8"));
    }
    assert.equal(readFileSync(join(current, "format-version"), "utf8").trim(), "4");
    assert.equal(mode(join(current, "mqtt-client.crl")), 0o644);
    assert.equal((readFileSync(join(current, "mqtt-client.crl"), "utf8").match(/BEGIN X509 CRL/g) ?? []).length, 2);
    assert.equal(mode(join(current, "device.crl")), 0o644);
    assert.equal((readFileSync(join(current, "device.crl"), "utf8").match(/BEGIN X509 CRL/g) ?? []).length, 2);
    assert.match(log, /read -format=raw gateway-mqtt-pki\/crl\/pem/);
    assert.match(log, /read -format=raw gateway-device-pki\/crl\/pem/);
    assert.doesNotMatch(stdout, /token|BEGIN .*PRIVATE KEY/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service issuer는 단일 CRL 형식의 기존 generation을 새 CRL bundle로 교체한다", () => {
  const directory = temporaryDirectory();
  const crlMaterial = createValidCrl(directory);
  const vault = writeMockVault(directory, crlMaterial);
  const output = join(directory, "bundle");
  const environment = {
    VAULT_BIN: vault,
    VAULT_ADDR: "https://vault.internal:8200",
    LAB_API_DNS: "api.lan",
    LAB_API_IP: "192.168.1.10",
    LAB_MQTT_DNS: "mqtt.lan",
    LAB_MQTT_IP: "192.168.1.11",
    PKI_ROOT_CRL_PATH: crlMaterial.rootCrl,
    PKI_SERVICE_CERT_DIR: output
  };
  try {
    run(issue, [], environment);
    const legacyGeneration = realpathSync(join(output, "current"));
    const firstCrl = readFileSync(join(legacyGeneration, "device.crl"), "utf8")
      .match(/-----BEGIN X509 CRL-----[\s\S]*?-----END X509 CRL-----/)?.[0];
    assert.ok(firstCrl);
    writeFileSync(join(legacyGeneration, "device.crl"), `${firstCrl}\n`);
    writeFileSync(join(legacyGeneration, "mqtt-client.crl"), `${firstCrl}\n`);
    writeFileSync(join(legacyGeneration, "format-version"), "3\n");

    run(issue, [], environment);

    const current = join(output, "current");
    assert.notEqual(realpathSync(current), legacyGeneration);
    assert.equal(readFileSync(join(current, "format-version"), "utf8").trim(), "4");
    assert.equal((readFileSync(join(current, "device.crl"), "utf8").match(/BEGIN X509 CRL/g) ?? []).length, 2);
    assert.equal((readFileSync(join(current, "mqtt-client.crl"), "utf8").match(/BEGIN X509 CRL/g) ?? []).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service bundle은 동일 SAN 재실행에 멱등이고 CRL 실패 시 기존 generation을 보존한다", () => {
  const directory = temporaryDirectory();
  const crlMaterial = createValidCrl(directory);
  const vault = writeMockVault(directory, crlMaterial);
  const output = join(directory, "bundle");
  const environment = {
    VAULT_BIN: vault,
    VAULT_ADDR: "https://vault.internal:8200",
    LAB_API_DNS: "api.lan",
    LAB_API_IP: "192.168.1.10",
    LAB_MQTT_DNS: "mqtt.lan",
    LAB_MQTT_IP: "192.168.1.11",
    PKI_ROOT_CRL_PATH: crlMaterial.rootCrl,
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
  assert.match(policy, /path "auth\/token\/lookup-self"\s*\{\s*capabilities = \["read"\]\s*\}/);
  assert.match(policy, /path "auth\/token\/renew-self"\s*\{\s*capabilities = \["update"\]\s*\}/);
  assert.doesNotMatch(policy, /auth\/token\/(?:create|revoke|lookup-accessor)|sudo/);
  assert.doesNotMatch(policy, /sign\/(?:mqtt-server|api-mqtt-client|api-server)/);
});
