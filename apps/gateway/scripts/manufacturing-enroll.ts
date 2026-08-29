import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { KeyMaterialStore } from "../src/identity/key-material-store";

const exec = promisify(execFile);
const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const URL = /^https:\/\/[^\s/]+(?:\/[^\s]*)?$/;
const PATH = /^\/[A-Za-z0-9._/-]+$/;
const MAX_ENROLLMENT_TOKEN_BYTES = 2048;
let stage = "input";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4) throw new Error("invalid enrollment input");
  const [serial, endpoint, identityRoot, apiCaPath] = args;
  if (!serial || !SERIAL.test(serial) || !endpoint || !URL.test(endpoint) || !identityRoot || !PATH.test(identityRoot) || !apiCaPath || !PATH.test(apiCaPath)) {
    throw new Error("invalid enrollment input");
  }
  stage = "token";
  const token = (await readEnrollmentToken()).trim();
  if (!token || /[\r\n]/.test(token)) throw new Error("invalid enrollment token");
  stage = "identity";
  const work = await mkdtemp(join(tmpdir(), "led-enroll-"));
  try {
    const store = new KeyMaterialStore({ identityRoot });
    const { csrPem } = await store.generateDeviceIdentity(serial);
    const body = JSON.stringify({ serialNumber: serial, token, csrPem });
    stage = "request";
    const response = await pipeTo("curl", ["--fail", "--silent", "--show-error", "--max-time", "30", "--cacert", apiCaPath, "-H", "content-type: application/json", "--data-binary", "@-", endpoint], body);
    stage = "verification";
    const value = JSON.parse(response.stdout) as Record<string, string>;
    for (const field of ["deviceCertificatePem", "deviceCaBundlePem", "apiCaBundlePem", "mqttCaBundlePem", "deviceCertificateFingerprint", "claimCode"]) {
      if (!value[field] || value[field].includes("PRIVATE KEY")) throw new Error("invalid enrollment response");
    }
    await writeFile(join(work, "device-response.crt"), value.deviceCertificatePem, { mode: 0o600 });
    await writeFile(join(work, "device-ca.pem"), value.deviceCaBundlePem, { mode: 0o600 });
    const fingerprint = (await exec("openssl", ["x509", "-in", join(work, "device-response.crt"), "-noout", "-fingerprint", "-sha256"])).stdout.replace(/^sha256 Fingerprint=/i, "").replace(/:/g, "").trim().toUpperCase();
    if (fingerprint !== value.deviceCertificateFingerprint.replace(/:/g, "").toUpperCase()) throw new Error("certificate fingerprint mismatch");
    await exec("openssl", ["verify", "-CAfile", join(work, "device-ca.pem"), join(work, "device-response.crt")]);
    stage = "install";
    await store.installIdentityBundle({ deviceCertificatePem: value.deviceCertificatePem, deviceCaBundlePem: value.deviceCaBundlePem, apiCaBundlePem: value.apiCaBundlePem, mqttCaBundlePem: value.mqttCaBundlePem });
    await exec("chown", ["-R", "gateway:gateway", identityRoot]);
    process.stdout.write(JSON.stringify({ serialNumber: serial, claimCode: value.claimCode, fingerprint }));
  } finally { await rm(work, { recursive: true, force: true }); }
}
main().catch(() => {
  process.stderr.write(`manufacturing enrollment failed stage=${stage}\n`);
  process.exitCode = stage === "input" ? 2 : 1;
});

async function readEnrollmentToken() {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_ENROLLMENT_TOKEN_BYTES) throw new Error("invalid enrollment token");
  }
  return input;
}

function pipeTo(command: string, args: string[], input: string) {
  return new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => reject(new Error("command failed")));
    child.on("close", (code) => code === 0 ? resolve({ stdout }) : reject(new Error("command failed")));
    child.stdin.end(input);
  });
}
