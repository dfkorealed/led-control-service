import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../");

describe("MQTT development security configuration", () => {
  it("requires client certificates and disables anonymous access", () => {
    const config = readFileSync(resolve(root, "infra/mosquitto.dev-tls.conf"), "utf8");
    expect(config).toContain("allow_anonymous false");
    expect(config).toContain("require_certificate true");
    expect(config).toContain("use_identity_as_username true");
  });

  it("keeps locally generated private keys out of git", () => {
    expect(readFileSync(resolve(root, ".gitignore"), "utf8")).toContain(".local/pki/");
  });
});
