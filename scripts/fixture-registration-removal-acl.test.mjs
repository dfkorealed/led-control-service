import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderMosquittoAcl } from "./dev-runtime.mjs";

test("registration removal has narrow bidirectional API and Gateway grants", () => {
  const gateway = "11111111-1111-4111-8111-111111111111";
  const rendered = renderMosquittoAcl([gateway]);
  const api = rendered.split(`user ${gateway}`)[0];
  for (const suffix of ["commands/registration-removal", "commands/registration-removal-ack"]) {
    assert.ok(api.includes(`topic write sites/+/gateways/+/${suffix}`), suffix);
    assert.ok(!api.includes(`topic read sites/+/gateways/+/${suffix}`));
  }
  assert.ok(api.includes("topic read sites/+/gateways/+/events/registration-removal"));
  assert.ok(!api.includes("topic write sites/+/gateways/+/events/registration-removal"));
  assert.ok(rendered.includes(`topic write sites/+/gateways/${gateway}/events/registration-removal`));
  const template = readFileSync(new URL("../infra/mosquitto.acl.example", import.meta.url), "utf8");
  assert.ok(template.includes("topic read sites/+/gateways/+/events/registration-removal"));
  assert.ok(template.includes("topic write sites/+/gateways/+/commands/registration-removal-ack"));
  assert.ok(template.includes("pattern write sites/+/gateways/%u/events/registration-removal"));
});
