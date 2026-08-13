import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const root = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const issuer = join(root, "scripts", "pki", "issue-lab-manufacturing-station.sh");

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "led-lab-manufacturing-test-"));
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function sandbox() {
  const directory = temporaryDirectory();
  const pkiDirectory = join(directory, "scripts", "pki");
  mkdirSync(pkiDirectory, { recursive: true });
  copyFileSync(issuer, join(pkiDirectory, "issue-lab-manufacturing-station.sh"));
  chmodSync(join(pkiDirectory, "issue-lab-manufacturing-station.sh"), 0o755);
  return directory;
}

function run(directory, environment = {}, args = []) {
  return execFileSync(join(directory, "scripts", "pki", "issue-lab-manufacturing-station.sh"), args, {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runFailure(directory, environment = {}, args = []) {
  try {
    run(directory, environment, args);
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.fail("manufacturing station issuer unexpectedly succeeded");
}

function output(directory) {
  return join(directory, ".local", "lab-pki", "manufacturing");
}

function details(path) {
  return execFileSync("openssl", ["x509", "-in", path, "-noout", "-text"], { encoding: "utf8" });
}

function assertCrlTrustedAndFresh(crl, ca) {
  execFileSync("openssl", ["crl", "-in", crl, "-noout", "-verify", "-CAfile", ca]);
  const nextUpdate = execFileSync("openssl", ["crl", "-in", crl, "-noout", "-nextupdate"], { encoding: "utf8" }).trim().replace("nextUpdate=", "");
  assert.ok(Date.parse(nextUpdate) > Date.now() + 24 * 60 * 60 * 1000);
}

test("issues a separate EC manufacturing CA and a client-auth-only station identity with restricted permissions", () => {
  const directory = sandbox();
  try {
    const stdout = run(directory, { PKI_ENV: "lab", LAB_MANUFACTURING_STATION_NAME: "macbook-station" });
    const manufacturing = output(directory);
    const ca = join(manufacturing, "manufacturing-ca.crt");
    const station = join(manufacturing, "station.crt");
    const key = join(manufacturing, "station.key");
    const chain = join(manufacturing, "station.chain.crt");
    const crl = join(manufacturing, "manufacturing.crl");

    assert.doesNotMatch(stdout, /PRIVATE KEY|token/i);
    assert.equal(mode(join(manufacturing, "manufacturing-ca.key")), 0o600);
    assert.equal(mode(ca), 0o644);
    assert.equal(mode(key), 0o600);
    assert.equal(mode(station), 0o644);
    assert.equal(mode(chain), 0o644);
    assert.equal(mode(crl), 0o644);
    execFileSync("openssl", ["verify", "-CAfile", ca, station]);
    execFileSync("openssl", ["crl", "-in", crl, "-noout"]);

    const caDetails = details(ca);
    const stationDetails = details(station);
    assert.match(caDetails, /id-ecPublicKey/);
    assert.match(caDetails, /CA:TRUE/);
    assert.match(stationDetails, /TLS Web Client Authentication/);
    assert.doesNotMatch(stationDetails, /TLS Web Server Authentication/);
    assert.match(stationDetails, /Basic Constraints: critical\s+CA:FALSE/);
    assert.match(stationDetails, /Key Usage: critical\s+Digital Signature/);
    assert.match(execFileSync("openssl", ["x509", "-in", station, "-noout", "-subject"], { encoding: "utf8" }), /CN\s*=\s*macbook-station/);
    assert.match(execFileSync("openssl", ["crl", "-in", crl, "-noout", "-issuer"], { encoding: "utf8" }), /CN\s*=\s*Lab Manufacturing CA/);
    assert.equal(readFileSync(chain, "utf8"), `${readFileSync(station, "utf8")}${readFileSync(ca, "utf8")}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects existing identities when a station certificate violates the exact leaf profile", () => {
  const directory = sandbox();
  try {
    const environment = { PKI_ENV: "lab", LAB_MANUFACTURING_STATION_NAME: "installer-a" };
    run(directory, environment);
    const manufacturing = output(directory);
    const station = join(manufacturing, "station.crt");
    const stationKey = join(manufacturing, "station.key");
    const ca = join(manufacturing, "manufacturing-ca.crt");
    const caKey = join(manufacturing, "manufacturing-ca.key");
    const generation = dirname(realpathSync(station));
    const replacement = join(generation, "station-replacement.crt");
    const csr = join(generation, "station-replacement.csr");
    const maliciousConfig = join(generation, "malicious.cnf");
    writeFileSync(maliciousConfig, `[bad_leaf]\nbasicConstraints = critical, CA:false\nkeyUsage = critical, digitalSignature\nextendedKeyUsage = critical, clientAuth, codeSigning\n`);
    execFileSync("openssl", ["req", "-new", "-key", stationKey, "-subj", "/CN=installer-a", "-out", csr]);
    execFileSync("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", replacement, "-days", "1", "-sha256", "-extfile", maliciousConfig, "-extensions", "bad_leaf"]);
    renameSync(replacement, realpathSync(station));
    writeFileSync(realpathSync(join(manufacturing, "station.chain.crt")), `${readFileSync(station, "utf8")}${readFileSync(ca, "utf8")}`);
    const failure = runFailure(directory, environment);
    assert.match(failure, /clientAuth.*only|clientAuth.*하나|EKU/i);

    assert.equal(existsSync(stationKey), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("revokes the station serial and atomically publishes a manufacturing CRL", () => {
  const directory = sandbox();
  try {
    const environment = { PKI_ENV: "lab", LAB_MANUFACTURING_STATION_NAME: "installer-a" };
    run(directory, environment);
    const manufacturing = output(directory);
    const station = join(manufacturing, "station.crt");
    const crl = join(manufacturing, "manufacturing.crl");
    const before = readFileSync(crl, "utf8");

    const stdout = run(directory, environment, ["revoke"]);
    assert.doesNotMatch(stdout, /PRIVATE KEY|token/i);
    const after = readFileSync(crl, "utf8");
    assert.notEqual(after, before);
    const serial = execFileSync("openssl", ["x509", "-in", station, "-noout", "-serial"], { encoding: "utf8" }).trim().replace("serial=", "");
    const crlDetails = execFileSync("openssl", ["crl", "-in", crl, "-noout", "-text"], { encoding: "utf8" });
    assert.match(crlDetails, new RegExp(serial, "i"));
    assert.equal(mode(crl), 0o644);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("issues a fresh station generation after revocation while retaining the old serial in the CRL", () => {
  const directory = sandbox();
  try {
    const environment = { PKI_ENV: "lab", LAB_MANUFACTURING_STATION_NAME: "installer-a" };
    run(directory, environment);
    const manufacturing = output(directory);
    const oldStation = join(manufacturing, "station.crt");
    const oldGeneration = dirname(realpathSync(oldStation));
    const oldSerial = execFileSync("openssl", ["x509", "-in", oldStation, "-noout", "-serial"], { encoding: "utf8" }).trim().replace("serial=", "");

    run(directory, environment, ["revoke"]);
    assert.match(readFileSync(join(oldGeneration, "index.txt"), "utf8"), new RegExp(`^R.*${oldSerial}`, "m"));
    run(directory, environment);

    const currentStation = join(manufacturing, "station.crt");
    const currentGeneration = join(manufacturing, readlinkSync(join(manufacturing, "current")));
    const currentSerial = execFileSync("openssl", ["x509", "-in", join(currentGeneration, "station.crt"), "-noout", "-serial"], { encoding: "utf8" }).trim().replace("serial=", "");
    assert.notEqual(currentGeneration, oldGeneration);
    assert.notEqual(currentSerial, oldSerial);
    assert.match(readFileSync(join(oldGeneration, "index.txt"), "utf8"), new RegExp(`^R.*${oldSerial}`, "m"));
    assert.match(execFileSync("openssl", ["crl", "-in", join(manufacturing, "manufacturing.crl"), "-noout", "-text"], { encoding: "utf8" }), new RegExp(oldSerial, "i"));

    const reusedCertificate = readFileSync(join(currentGeneration, "station.crt"), "utf8");
    run(directory, environment);
    assert.equal(readFileSync(join(manufacturing, readlinkSync(join(manufacturing, "current")), "station.crt"), "utf8"), reusedCertificate);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repairs missing, expiring, or incorrectly signed CRLs before reusing an active station", () => {
  const directory = sandbox();
  const other = sandbox();
  try {
    const environment = { PKI_ENV: "lab", LAB_MANUFACTURING_STATION_NAME: "installer-a" };
    run(directory, environment);
    run(other, environment);
    const manufacturing = output(directory);
    const station = join(manufacturing, "station.crt");
    const crl = join(manufacturing, "manufacturing.crl");
    const generation = dirname(realpathSync(station));
    const config = join(generation, "openssl.cnf");
    const originalConfig = readFileSync(config, "utf8");
    const expiring = join(generation, "expiring.crl");

    writeFileSync(config, originalConfig.replace("default_crl_days = 7", "default_crl_hours = 1"));
    execFileSync("openssl", ["ca", "-config", config, "-gencrl", "-out", expiring], { stdio: "ignore" });
    writeFileSync(config, originalConfig);
    copyFileSync(expiring, realpathSync(crl));
    run(directory, environment);
    assertCrlTrustedAndFresh(crl, join(manufacturing, "manufacturing-ca.crt"));

    copyFileSync(join(output(other), "manufacturing.crl"), realpathSync(crl));
    run(directory, environment);
    assertCrlTrustedAndFresh(crl, join(manufacturing, "manufacturing-ca.crt"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("reuses a valid station identity and rejects a different station name without overwriting it", () => {
  const directory = sandbox();
  try {
    const environment = { PKI_ENV: "lab", LAB_MANUFACTURING_STATION_NAME: "installer-a" };
    run(directory, environment);
    const manufacturing = output(directory);
    const initialCertificate = readFileSync(join(manufacturing, "station.crt"), "utf8");
    const initialKey = readFileSync(join(manufacturing, "station.key"), "utf8");

    run(directory, environment);
    assert.equal(readFileSync(join(manufacturing, "station.crt"), "utf8"), initialCertificate);
    assert.equal(readFileSync(join(manufacturing, "station.key"), "utf8"), initialKey);

    const failure = runFailure(directory, { PKI_ENV: "lab", LAB_MANUFACTURING_STATION_NAME: "installer-b" });
    assert.match(failure, /identity mismatch|station.*(mismatch|충돌)|station.*이름/i);
    assert.equal(readFileSync(join(manufacturing, "station.crt"), "utf8"), initialCertificate);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects invalid station names and non-lab environments before creating manufacturing material", () => {
  const directory = sandbox();
  try {
    const invalidName = runFailure(directory, { PKI_ENV: "lab", LAB_MANUFACTURING_STATION_NAME: "invalid/name" });
    assert.match(invalidName, /station.*name|station.*이름/i);
    assert.equal(existsSync(output(directory)), false);

    const production = runFailure(directory, { PKI_ENV: "production", LAB_MANUFACTURING_STATION_NAME: "installer-a" });
    assert.match(production, /PKI_ENV=lab|Lab 전용/i);
    assert.equal(existsSync(output(directory)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a station key that no longer matches the certificate", () => {
  const directory = sandbox();
  try {
    const environment = { PKI_ENV: "lab", LAB_MANUFACTURING_STATION_NAME: "installer-a" };
    run(directory, environment);
    const key = join(output(directory), "station.key");
    execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
    chmodSync(key, 0o600);

    const failure = runFailure(directory, environment);
    assert.match(failure, /public key|공개키/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
