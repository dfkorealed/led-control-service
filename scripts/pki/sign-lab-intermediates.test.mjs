import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const root = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const signer = join(root, "scripts", "pki", "sign-lab-intermediates.sh");
const purposes = ["gateway-device", "gateway-mqtt", "api-server"];

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "led-lab-root-test-"));
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function run(environment) {
  return execFileSync(signer, [], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runFailure(environment) {
  try {
    run(environment);
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

function environment(directory) {
  return {
    PKI_ENV: "lab",
    PKI_CSR_DIR: join(directory, "csrs"),
    LAB_ROOT_DIR: join(directory, "root"),
    LAB_SIGNED_INTERMEDIATE_DIR: join(directory, "signed")
  };
}

test("creates an EC P-256 Lab Root and pathlen zero intermediate chains with restricted key permissions", () => {
  const directory = temporaryDirectory();
  try {
    const env = environment(directory);
    execFileSync("mkdir", ["-p", env.PKI_CSR_DIR]);
    makeCsrs(env.PKI_CSR_DIR);

    const stdout = run(env);
    assert.doesNotMatch(stdout, /PRIVATE KEY|token/i);
    assert.equal(mode(join(env.LAB_ROOT_DIR, "root.key")), 0o600);
    assert.equal(mode(join(env.LAB_ROOT_DIR, "root.crt")), 0o644);
    assert.match(execFileSync("openssl", ["x509", "-in", join(env.LAB_ROOT_DIR, "root.crt"), "-text", "-noout"], { encoding: "utf8" }), /id-ecPublicKey/);

    for (const purpose of purposes) {
      const certificate = join(env.LAB_SIGNED_INTERMEDIATE_DIR, `${purpose}-intermediate.crt`);
      const chain = join(env.LAB_SIGNED_INTERMEDIATE_DIR, `${purpose}-intermediate.chain.crt`);
      const fingerprint = join(env.LAB_SIGNED_INTERMEDIATE_DIR, `${purpose}-intermediate.csr.sha256`);
      assert.equal(mode(certificate), 0o644);
      assert.equal(mode(chain), 0o644);
      assert.equal(mode(fingerprint), 0o644);
      execFileSync("openssl", ["verify", "-CAfile", join(env.LAB_ROOT_DIR, "root.crt"), certificate]);
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
  const directory = temporaryDirectory();
  try {
    const env = environment(directory);
    execFileSync("mkdir", ["-p", env.PKI_CSR_DIR]);
    makeCsrs(env.PKI_CSR_DIR);
    run(env);
    const chain = join(env.LAB_SIGNED_INTERMEDIATE_DIR, "gateway-device-intermediate.chain.crt");
    const initialChain = readFileSync(chain, "utf8");

    run(env);
    assert.equal(readFileSync(chain, "utf8"), initialChain);

    makeCsr(env.PKI_CSR_DIR, "gateway-device", "-replacement");
    const output = runFailure(env);
    assert.match(output, /CSR.*(changed|conflict)|CSR.*충돌/i);
    assert.equal(readFileSync(chain, "utf8"), initialChain);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects non-lab environments before creating Root material", () => {
  const directory = temporaryDirectory();
  try {
    const env = environment(directory);
    execFileSync("mkdir", ["-p", env.PKI_CSR_DIR]);
    makeCsrs(env.PKI_CSR_DIR);
    const output = runFailure({ ...env, PKI_ENV: "production" });
    assert.match(output, /PKI_ENV=lab|Lab 전용/);
    assert.equal(existsSync(join(env.LAB_ROOT_DIR, "root.key")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
