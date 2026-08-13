import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const root = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const signer = join(root, "scripts", "pki", "sign-lab-intermediates.sh");
const fileHelper = join(root, "scripts", "pki", "lab-pki-files.mjs");
const bootstrap = join(root, "scripts", "pki", "bootstrap-lab-vault.sh");
const policy = join(root, "infra", "vault", "policies", "gateway-pki.hcl");
const purposes = ["gateway-device", "gateway-mqtt", "api-server"];

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "led-lab-root-test-"));
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function sandbox() {
  const directory = temporaryDirectory();
  const pkiDirectory = join(directory, "scripts", "pki");
  mkdirSync(pkiDirectory, { recursive: true });
  copyFileSync(signer, join(pkiDirectory, "sign-lab-intermediates.sh"));
  copyFileSync(fileHelper, join(pkiDirectory, "lab-pki-files.mjs"));
  copyFileSync(bootstrap, join(pkiDirectory, "bootstrap-lab-vault.sh"));
  mkdirSync(join(directory, "infra", "vault", "policies"), { recursive: true });
  copyFileSync(policy, join(directory, "infra", "vault", "policies", "gateway-pki.hcl"));
  chmodSync(join(pkiDirectory, "sign-lab-intermediates.sh"), 0o755);
  chmodSync(join(pkiDirectory, "bootstrap-lab-vault.sh"), 0o755);
  return directory;
}

function run(directory, environment = {}) {
  return execFileSync(join(directory, "scripts", "pki", "sign-lab-intermediates.sh"), [], {
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
  assert.fail("signer unexpectedly succeeded");
}

function makeCsr(directory, purpose, suffix = "") {
  const key = join(directory, `${purpose}${suffix}.key`);
  const csr = join(directory, `${purpose}-intermediate.csr`);
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
  execFileSync("openssl", ["req", "-new", "-key", key, "-subj", `/CN=${purpose}${suffix} Lab Intermediate`, "-out", csr]);
  return csr;
}

function makeCsrs(directory) {
  for (const purpose of purposes) makeCsr(directory, purpose);
}

function paths(directory) {
  const pki = join(directory, ".local", "lab-pki");
  return { csrs: join(pki, "csrs"), root: join(pki, "root"), signed: join(pki, "signed-intermediates") };
}

test("creates an EC P-256 Lab Root and pathlen zero intermediate chains with restricted key permissions", () => {
  const directory = sandbox();
  try {
    const output = paths(directory);
    execFileSync("mkdir", ["-p", output.csrs]);
    makeCsrs(output.csrs);

    const stdout = run(directory, { PKI_ENV: "lab", PKI_CSR_DIR: "/ignored" });
    assert.doesNotMatch(stdout, /PRIVATE KEY|token/i);
    assert.equal(mode(join(output.root, "root.key")), 0o600);
    assert.equal(mode(join(output.root, "root.crt")), 0o644);
    assert.match(execFileSync("openssl", ["x509", "-in", join(output.root, "root.crt"), "-text", "-noout"], { encoding: "utf8" }), /id-ecPublicKey/);

    for (const purpose of purposes) {
      const certificate = join(output.signed, `${purpose}-intermediate.crt`);
      const chain = join(output.signed, `${purpose}-intermediate.chain.crt`);
      const fingerprint = join(output.signed, `${purpose}-intermediate.csr.sha256`);
      assert.equal(mode(certificate), 0o644);
      assert.equal(mode(chain), 0o644);
      assert.equal(mode(fingerprint), 0o644);
      execFileSync("openssl", ["verify", "-CAfile", join(output.root, "root.crt"), certificate]);
      const details = execFileSync("openssl", ["x509", "-in", certificate, "-text", "-noout"], { encoding: "utf8" });
      assert.match(details, /CA:TRUE, pathlen:0/);
      assert.match(details, /Certificate Sign, CRL Sign/);
      assert.match(readFileSync(chain, "utf8"), /BEGIN CERTIFICATE/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reuses valid output for the same CSR and rejects a changed CSR for an existing purpose", () => {
  const directory = sandbox();
  try {
    const output = paths(directory);
    execFileSync("mkdir", ["-p", output.csrs]);
    makeCsrs(output.csrs);
    run(directory, { PKI_ENV: "lab" });
    const chain = join(output.signed, "gateway-device-intermediate.chain.crt");
    const initialChain = readFileSync(chain, "utf8");

    run(directory, { PKI_ENV: "lab" });
    assert.equal(readFileSync(chain, "utf8"), initialChain);

    makeCsr(output.csrs, "gateway-device", "-replacement");
    const failure = runFailure(directory, { PKI_ENV: "lab" });
    assert.match(failure, /CSR.*(changed|conflict)|CSR.*충돌/i);
    assert.equal(readFileSync(chain, "utf8"), initialChain);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects non-lab environments before creating Root material", () => {
  const directory = sandbox();
  try {
    const output = paths(directory);
    execFileSync("mkdir", ["-p", output.csrs]);
    makeCsrs(output.csrs);
    const failure = runFailure(directory, { PKI_ENV: "production" });
    assert.match(failure, /PKI_ENV=lab|Lab 전용/);
    assert.equal(existsSync(join(output.root, "root.key")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a mismatched Root key and safely recovers an interrupted generation directory", () => {
  const directory = sandbox();
  try {
    const output = paths(directory);
    mkdirSync(output.csrs, { recursive: true });
    makeCsrs(output.csrs);
    run(directory, { PKI_ENV: "lab" });
    execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", join(output.root, "root.key")]);
    chmodSync(join(output.root, "root.key"), 0o600);
    assert.match(runFailure(directory, { PKI_ENV: "lab" }), /public key|공개키/i);

    rmSync(output.root, { recursive: true, force: true });
    rmSync(output.signed, { recursive: true, force: true });
    mkdirSync(join(output.signed, ".generation-tmp-interrupted"), { recursive: true });
    writeFileSync(join(output.signed, ".generation-tmp-interrupted", "partial"), "partial");
    run(directory, { PKI_ENV: "lab" });
    assert.equal(existsSync(join(output.signed, ".generation-tmp-interrupted")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent signers without deleting an active lock or reusing intermediate serials", async () => {
  const directory = sandbox();
  try {
    const output = paths(directory);
    mkdirSync(output.csrs, { recursive: true });
    makeCsrs(output.csrs);
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const openssl = execFileSync("which", ["openssl"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "openssl"), `#!/usr/bin/env bash\nif [[ \"$1\" == \"x509\" ]]; then sleep 1; fi\nexec \"${openssl}\" \"$@\"\n`);
    chmodSync(join(bin, "openssl"), 0o755);
    const environment = { ...process.env, PKI_ENV: "lab", PATH: `${bin}:${process.env.PATH}` };
    const first = spawn(join(directory, "scripts", "pki", "sign-lab-intermediates.sh"), [], { cwd: directory, env: environment });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("signer lock was not created")), 3000);
      const check = () => {
        if (existsSync(join(directory, ".local", "lab-pki", ".intermediate-sign.lock"))) {
          clearTimeout(timer);
          resolve();
          return;
        }
        setTimeout(check, 20);
      };
      check();
    });
    const failure = runFailure(directory, { PKI_ENV: "lab", LAB_SIGNER_LOCK_TIMEOUT_SECONDS: "0", PATH: environment.PATH });
    assert.match(failure, /stale lock|signer가 실행 중/i);
    const firstExit = await new Promise((resolve) => first.on("close", resolve));
    assert.equal(firstExit, 0);
    const serials = new Set(purposes.map((purpose) => execFileSync("openssl", ["x509", "-in", join(output.signed, `${purpose}-intermediate.crt`), "-noout", "-serial"], { encoding: "utf8" }).trim()));
    assert.equal(serials.size, purposes.length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a serial symlink before OpenSSL can modify its external target", () => {
  const directory = sandbox();
  try {
    const output = paths(directory);
    mkdirSync(output.csrs, { recursive: true });
    makeCsrs(output.csrs);
    run(directory, { PKI_ENV: "lab" });
    rmSync(output.signed, { recursive: true, force: true });
    const externalSerial = join(directory, "external-serial");
    writeFileSync(externalSerial, "ABCD\n");
    rmSync(join(output.root, "intermediate.srl"));
    execFileSync("ln", ["-s", externalSerial, join(output.root, "intermediate.srl")]);

    const failure = runFailure(directory, { PKI_ENV: "lab" });
    assert.match(failure, /symlink.*(serial|intermediate\.srl)|serial.*(symlink|일반 파일)/i);
    assert.equal(readFileSync(externalSerial, "utf8"), "ABCD\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uses the shared default Lab PKI paths for prepare, sign, and install", () => {
  const directory = sandbox();
  try {
    const output = paths(directory);
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const vault = join(bin, "vault");
    writeFileSync(vault, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${directory}/vault.log"
if [[ "$1" == "secrets" ]]; then printf '[]\\n'; exit 0; fi
if [[ "$1" == "list" ]]; then printf '["issuer"]\\n'; exit 0; fi
if [[ "$1 $2" == "write -field=csr" ]]; then
  key="$(mktemp)"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$key" >/dev/null 2>&1
  openssl req -new -key "$key" -subj "/CN=Lab Intermediate" 2>/dev/null
  rm -f "$key"
fi
`);
    chmodSync(vault, 0o755);
    const env = { PKI_ENV: "lab", VAULT_ADDR: "http://vault.lab:8200", VAULT_BIN: vault };
    execFileSync(join(directory, "scripts", "pki", "bootstrap-lab-vault.sh"), ["prepare"], { cwd: directory, env: { ...process.env, ...env }, stdio: "pipe" });
    run(directory, env);
    execFileSync(join(directory, "scripts", "pki", "bootstrap-lab-vault.sh"), ["install"], { cwd: directory, env: { ...process.env, ...env }, stdio: "pipe" });
    const log = readFileSync(join(directory, "vault.log"), "utf8");
    assert.match(log, /gateway-device-pki\/intermediate\/set-signed/);
    for (const purpose of purposes) assert.equal(existsSync(join(output.signed, `${purpose}-intermediate.chain.crt`)), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
