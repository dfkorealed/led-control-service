import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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

function run(directory, environment = {}) {
  return execFileSync(join(directory, "scripts", "pki", "issue-lab-manufacturing-station.sh"), [], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runFailure(directory, environment = {}) {
  try {
    run(directory, environment);
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.fail("manufacturing station issuer unexpectedly succeeded");
}

function output(directory) {
  return join(directory, ".local", "lab-pki", "manufacturing");
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

    assert.doesNotMatch(stdout, /PRIVATE KEY|token/i);
    assert.equal(mode(join(manufacturing, "manufacturing-ca.key")), 0o600);
    assert.equal(mode(ca), 0o644);
    assert.equal(mode(key), 0o600);
    assert.equal(mode(station), 0o644);
    assert.equal(mode(chain), 0o644);
    execFileSync("openssl", ["verify", "-CAfile", ca, station]);

    const caDetails = execFileSync("openssl", ["x509", "-in", ca, "-noout", "-text"], { encoding: "utf8" });
    const stationDetails = execFileSync("openssl", ["x509", "-in", station, "-noout", "-text"], { encoding: "utf8" });
    assert.match(caDetails, /id-ecPublicKey/);
    assert.match(caDetails, /CA:TRUE/);
    assert.match(stationDetails, /TLS Web Client Authentication/);
    assert.doesNotMatch(stationDetails, /TLS Web Server Authentication/);
    assert.match(execFileSync("openssl", ["x509", "-in", station, "-noout", "-subject"], { encoding: "utf8" }), /CN\s*=\s*macbook-station/);
    assert.equal(readFileSync(chain, "utf8"), `${readFileSync(station, "utf8")}${readFileSync(ca, "utf8")}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
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
