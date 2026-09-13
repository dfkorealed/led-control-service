import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
const execFile = promisify(callback);
const root = path.resolve(import.meta.dirname, "../../..");

// Removing the early branch must invoke the poisoned mkdir instead of Node.
// Only executable dependencies are replaced; the real entrypoint is executed.
for (const adapter of ["bio-usb", "bluez", "invalid"]) {
  test(`bootstrap-only bypasses all hardware and filesystem setup with adapter=${adapter}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bootstrap-entrypoint-"));
    try {
      for (const name of ["mkdir", "chmod", "chown", "dbus-daemon", "btmgmt", "bluetooth-meshd", "gateway-bio-usb-preflight", "setpriv", "runuser"]) {
        await writeFile(path.join(dir,name), '#!/bin/sh\necho forbidden >&2\nexit 91\n', {mode:0o755});
      }
      await writeFile(path.join(dir,"node"), '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = /opt/led-control/bootstrap-only.mjs ] || exit 92\nprintf "cli-only\\n"\n', {mode:0o755});
      const result = await execFile("/bin/sh", [path.join(root,"apps/gateway/docker/entrypoint.sh"),"bootstrap-only"],
        { env:{...process.env,PATH:`${dir}:/usr/bin:/bin`,GATEWAY_ADAPTER:adapter} });
      assert.equal(result.stdout,"cli-only\n"); assert.equal(result.stderr,"");
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
}

test("dedicated artifact build graph cannot import hardware, runtime, or index entrypoint", async () => {
  const dockerfile = await readFile(path.join(root,"apps/gateway/docker/Dockerfile"),"utf8");
  assert.match(dockerfile,/src\/bootstrap-only\.ts/);
  assert.match(dockerfile,/COPY --from=app-builder \/tmp\/bootstrap-only\.mjs \/opt\/led-control\/bootstrap-only\.mjs/);
  const { build } = await import(path.join(root,"apps/gateway/node_modules/esbuild/lib/main.js"));
  const result = await build({entryPoints:[path.join(root,"apps/gateway/src/bootstrap-only.ts")],bundle:true,platform:"node",format:"esm",packages:"external",metafile:true,write:false});
  for (const input of Object.keys(result.metafile.inputs)) {
    assert.doesNotMatch(input,/\/adapters\/|\/mesh\/|\/runtime\/|\/usb\/|src\/index\.ts$/);
  }
  for(const output of Object.values(result.metafile.outputs)) for(const item of output.imports) {
    assert.doesNotMatch(item.path,/dbus|usb|automation-engine/);
  }
});

test("standalone bootstrap compose grants no hardware, root, restart, healthcheck, or old data mount", async () => {
  const {stdout}=await execFile("docker",["compose","-f",path.join(root,"apps/gateway/compose.bootstrap.yml"),"config","--format","json"],
    {env:{...process.env,GATEWAY_IMAGE:"test:bootstrap",GATEWAY_BOOTSTRAP_DATA_DIR:"/tmp/new-identity",GATEWAY_SERIAL:"NEW",GATEWAY_EXPECTED_SITE_ID:"11111111-1111-4111-8111-111111111111",GATEWAY_EXPECTED_GATEWAY_ID:"22222222-2222-4222-8222-222222222222",GATEWAY_BOOTSTRAP_URL:"https://api.example/gateway-bootstrap"}});
  const cfg=JSON.parse(stdout); assert.deepEqual(Object.keys(cfg.services),["gateway-bootstrap"]);
  const service=cfg.services["gateway-bootstrap"];
  assert.equal(service.user,"gateway:gateway"); assert.equal(service.privileged,undefined);
  assert.deepEqual(service.cap_drop,["ALL"]); assert.equal(service.devices,undefined);
  assert.equal(service.restart,"no"); assert.equal(service.healthcheck.disable,true);
  assert.deepEqual(service.command,["bootstrap-only"]);
  assert.deepEqual(service.volumes.map(v=>[v.source,v.target]),[["/tmp/new-identity/identity","/data/identity"],["/tmp/new-identity/gateway","/data/gateway"]]);
});
