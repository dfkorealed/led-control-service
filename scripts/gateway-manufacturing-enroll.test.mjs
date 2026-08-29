import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = await readFile(new URL("./gateway-manufacturing-enroll.sh", import.meta.url), "utf8");
const enrollmentRunner = await readFile(new URL("../apps/gateway/scripts/manufacturing-enroll.ts", import.meta.url), "utf8");
const firstInstallRunbook = await readFile(new URL("../docs/runbooks/device-lab-first-install.md", import.meta.url), "utf8");
const applianceRunbook = await readFile(new URL("../docs/runbooks/raspberry-pi-gateway-appliance.md", import.meta.url), "utf8");

test("manufacturing enrollment keeps the token in a pipe and never in argv, temp files, or stdout", () => {
  assert.match(script, /manufacturing\/gateway-enrollments/);
  assert.match(script, /jq[^\n]*enrollmentToken/);
  assert.match(script, /ssh[\s\S]*manufacturing-enroll/);
  assert.doesNotMatch(script, /mktemp[^\n]*(token|enroll)/i);
  assert.doesNotMatch(script, /echo[^\n]*token/);
  assert.doesNotMatch(script, /ssh[^\n]*enrollmentToken/);
});

test("manufacturing enrollment validates command inputs and installs a verified identity", () => {
  assert.match(script, /SERIAL_PATTERN=/);
  assert.match(script, /TARGET_PATTERN=/);
  assert.match(script, /PATH_PATTERN=/);
  assert.match(script, /--/);
  assert.match(script, /manufacturing-enroll\.mjs/);
  assert.match(script, /docker run --rm -i --network host/);
  assert.match(script, /mktemp "\$\{LABEL_OUTPUT\}\.tmp\.XXXXXX"/);
  assert.match(script, /mv "\$TMP_LABEL" "\$LABEL_OUTPUT"/);
});

test("manufacturing enrollment rejects missing or incomplete CLI options with exit 2", () => {
  for (const args of [[], ["--target"]]) {
    const result = spawnSync(fileURLToPath(new URL("./gateway-manufacturing-enroll.sh", import.meta.url)), args, {
      encoding: "utf8"
    });
    assert.equal(result.status, 2);
  }
});

test("manufacturing enrollment accepts a valid HTTPS URL and canonical station symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-enroll-url-"));
  try {
    const stationCertTarget = join(directory, "station-generation.crt");
    const stationKeyTarget = join(directory, "station-generation.key");
    const stationCaTarget = join(directory, "ca-generation.crt");
    for (const path of [stationCertTarget, stationKeyTarget, stationCaTarget]) writeFileSync(path, "placeholder\n");
    chmodSync(stationKeyTarget, 0o600);
    const stationCert = join(directory, "station.crt");
    const stationKey = join(directory, "station.key");
    const stationCa = join(directory, "ca.crt");
    symlinkSync(stationCertTarget, stationCert);
    symlinkSync(stationKeyTarget, stationKey);
    symlinkSync(stationCaTarget, stationCa);

    const result = spawnSync(fileURLToPath(new URL("./gateway-manufacturing-enroll.sh", import.meta.url)), [
      "--target", "gateway@127.0.0.1",
      "--serial", "GW-RPI-000001",
      "--label-output", join(directory, "label.json")
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        MANUFACTURING_API_URL: "https://127.0.0.1:9",
        STATION_CERT: stationCert,
        STATION_KEY: stationKey,
        STATION_CA: stationCa,
        GATEWAY_IMAGE: "led-control-gateway:test"
      }
    });

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /invalid (?:enrollment input|station credential path)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manufacturing enrollment re-run accepts an existing restricted label without contacting the API", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-enroll-rerun-"));
  try {
    const stationCert = join(directory, "station.crt");
    const stationKey = join(directory, "station.key");
    const stationCa = join(directory, "ca.crt");
    for (const path of [stationCert, stationKey, stationCa]) writeFileSync(path, "placeholder\n");
    chmodSync(stationKey, 0o600);
    const labelOutput = join(directory, "label.json");
    writeFileSync(labelOutput, JSON.stringify({
      serialNumber: "GW-RPI-000001",
      claimCode: "C".repeat(21),
      fingerprint: "A".repeat(64)
    }));
    chmodSync(labelOutput, 0o600);
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    const curl = join(binDirectory, "curl");
    writeFileSync(curl, "#!/usr/bin/env bash\nexit 99\n", { mode: 0o700 });

    const result = spawnSync(fileURLToPath(new URL("./gateway-manufacturing-enroll.sh", import.meta.url)), [
      "--target", "gateway@127.0.0.1",
      "--serial", "GW-RPI-000001",
      "--label-output", labelOutput
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH}`,
        MANUFACTURING_API_URL: "https://127.0.0.1:9",
        STATION_CERT: stationCert,
        STATION_KEY: stationKey,
        STATION_CA: stationCa,
        GATEWAY_IMAGE: "led-control-gateway:test"
      }
    });

    assert.equal(result.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Docker image contains the manufacturing enrollment bundle", async () => {
  const dockerfile = await readFile(new URL("../apps/gateway/docker/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /manufacturing-enroll/);
  assert.match(dockerfile, /manufacturing-enroll\.mjs/);
});

test("manufacturing runner reports only a bounded failure stage", () => {
  for (const stage of ["input", "token", "identity", "request", "verification", "install"]) {
    assert.match(enrollmentRunner, new RegExp(`stage = "${stage}"`));
  }
  assert.match(enrollmentRunner, /stage=\$\{stage\}/);
  assert.doesNotMatch(enrollmentRunner, /catch\s*\(error\)[\s\S]*error\.message/);
  assert.match(enrollmentRunner, /process\.exitCode = stage === "input" \? 2 : 1/);
});

test("manufacturing runner reads bounded stdin without fs.promises numeric descriptors", () => {
  assert.doesNotMatch(enrollmentRunner, /readFile\(0/);
  assert.match(enrollmentRunner, /for await \(const chunk of process\.stdin\)/);
  assert.match(enrollmentRunner, /MAX_ENROLLMENT_TOKEN_BYTES/);
});

test("manufacturing runbooks pass options directly to the pnpm script", () => {
  for (const runbook of [firstInstallRunbook, applianceRunbook]) {
    assert.match(runbook, /pnpm gateway:manufacturing:enroll \\\n\s+--target/);
    assert.doesNotMatch(runbook, /pnpm gateway:manufacturing:enroll -- \\\n/);
  }
});
