import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderMosquittoAcl } from "../../../scripts/dev-runtime.mjs";

test("static production/lab and generated dev ACL authorize identify only in the gateway CN namespace", () => {
  const acl = readFileSync(new URL("../../../infra/mosquitto.acl.example", import.meta.url), "utf8");
  assert.match(acl, /^pattern read sites\/\+\/gateways\/%u\/commands\/#$/m);
  assert.match(acl, /^pattern write sites\/\+\/gateways\/%u\/events\/#$/m);
  assert.doesNotMatch(acl, /^pattern write .*\/commands\//m);
  const id = "00000000-0000-4000-8000-000000000004";
  const generated = renderMosquittoAcl(id);
  assert.ok(generated.includes(`topic read sites/+/gateways/${id}/commands/#`));
  assert.ok(generated.includes(`topic write sites/+/gateways/${id}/events/#`));
  assert.ok(!generated.includes(`topic write sites/+/gateways/${id}/commands/`));
});
