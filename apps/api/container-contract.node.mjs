import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';

const filename = path.join(import.meta.dirname, "Dockerfile");
test("API build supplies frozen dependencies, Prisma and compiled workspaces in order", () => {
  assert.ok(existsSync(filename), "API Dockerfile is missing");
  const file = readFileSync(filename, "utf8");
  assert.match(file, /pnpm install --frozen-lockfile/);
  assert.match(file, /COPY patches patches/);
  assert.match(file, /prisma:generate/);
  assert.ok(file.indexOf("@led-control/shared build") < file.indexOf("@led-control/automation-engine build"));
  assert.ok(file.indexOf("@led-control/automation-engine build") < file.indexOf("@led-control/api build"));
  assert.match(file, /deploy --prod/);
});

test("CRL initializer fails before writing outputs when a read-only seed is missing", () => {
  const script=path.join(import.meta.dirname,'container-init-crls.cjs');
  assert.ok(existsSync(script),'CRL initializer missing');
  const dir=mkdtempSync(path.join(tmpdir(),'led-crl-init-contract-'));
  try {
    for(const name of ['device','mqtt']) mkdirSync(path.join(dir,name));
    writeFileSync(path.join(dir,'present.crl'),'invalid seed');
    const result=spawnSync(process.execPath,[script],{env:{PATH:process.env.PATH,DEVICE_CRL_SEED_PATH:path.join(dir,'missing.crl'),MQTT_CRL_SEED_PATH:path.join(dir,'present.crl'),DEVICE_CRL_OUTPUT_PATH:path.join(dir,'device/device.crl'),MQTT_CRL_OUTPUT_PATH:path.join(dir,'mqtt/mqtt-client.crl')},encoding:'utf8'});
    assert.equal(result.status,1);
    assert.equal(result.stderr.trim(),'CRL seed initialization failed');
    assert.deepEqual(readdirSync(path.join(dir,'device')),[]);
    assert.deepEqual(readdirSync(path.join(dir,'mqtt')),[]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("API runtime is non-root and signal-safe with compiled entrypoint and local migration CLI", () => {
  assert.ok(existsSync(filename), "API Dockerfile is missing");
  const file = readFileSync(filename, "utf8").split(/FROM .* AS runtime/)[1];
  assert.ok(file);
  assert.match(file, /USER (?:node|1000)/);
  assert.match(file, /ENTRYPOINT \["\/sbin\/tini", "--"\]/);
  assert.match(file, /CMD \["node", "dist\/src\/main.js"\]/);
  assert.match(file, /COPY --from=build .*migration/);
  assert.doesNotMatch(file, /pnpm install|nest start|tsx|ts-node/);
});
