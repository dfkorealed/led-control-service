import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(new URL("./gateway-manufacturing-enroll.sh", import.meta.url), "utf8");
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

test("Docker image contains the manufacturing enrollment bundle", async () => {
  const dockerfile = await readFile(new URL("../apps/gateway/docker/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /manufacturing-enroll/);
  assert.match(dockerfile, /manufacturing-enroll\.mjs/);
});

test("manufacturing runbooks pass options directly to the pnpm script", () => {
  for (const runbook of [firstInstallRunbook, applianceRunbook]) {
    assert.match(runbook, /pnpm gateway:manufacturing:enroll \\\n\s+--target/);
    assert.doesNotMatch(runbook, /pnpm gateway:manufacturing:enroll -- \\\n/);
  }
});
