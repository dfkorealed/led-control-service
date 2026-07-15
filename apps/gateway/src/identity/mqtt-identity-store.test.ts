import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { MqttIdentityStore } from "./mqtt-identity-store";

const execFile = promisify(execFileCallback);

describe("MqttIdentityStore", () => {
  it("creates an ECDSA MQTT generation with the assigned gateway CN and hardened permissions", async () => {
    const fixture = await createFixture();
    const gatewayId = "gateway-27";
    const issued = await fixture.store.ensure(gatewayId, fixture.mqttCaPem, async (csrPem) => ({
      gatewayId,
      ...(await signCsr(fixture.directory, csrPem, gatewayId))
    }));

    expect(issued).toBe(true);
    const currentTarget = await readlink(join(fixture.identityRoot, "current"));
    const generationPath = join(fixture.identityRoot, currentTarget);
    expect(currentTarget).toMatch(/^generations\/[0-9a-f-]+$/);
    await expect(stat(join(generationPath, "gateway.key"))).resolves.toMatchObject({ mode: expect.any(Number) });
    expect((await stat(join(generationPath, "gateway.key"))).mode & 0o777).toBe(0o600);
    for (const name of ["gateway.crt", "gateway-chain.crt", "mqtt-ca.crt"]) {
      expect((await stat(join(generationPath, name))).mode & 0o777).toBe(0o644);
    }
    expect((await readFile(join(generationPath, "gateway.crt"), "utf8")).match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(2);
    await expect(readFile(join(generationPath, "mqtt-ca.crt"), "utf8")).resolves.toBe(fixture.mqttCaPem);
    await expect(execFile("openssl", [
      "x509", "-in", join(generationPath, "gateway.crt"), "-noout", "-subject", "-nameopt", "RFC2253"
    ])).resolves.toMatchObject({ stdout: "subject=CN=gateway-27\n" });
    await expect(execFile("openssl", [
      "verify", "-purpose", "sslclient", "-CAfile", join(generationPath, "gateway-chain.crt"),
      join(generationPath, "gateway.crt")
    ])).resolves.toMatchObject({ stdout: expect.stringContaining("OK") });
  });

  it("reuses a valid assigned identity without requesting another certificate", async () => {
    const fixture = await createFixture();
    const gatewayId = "gateway-27";
    const issue = async (csrPem: string) => ({ gatewayId, ...(await signCsr(fixture.directory, csrPem, gatewayId)) });

    await fixture.store.ensure(gatewayId, fixture.mqttCaPem, issue);
    await expect(fixture.store.ensure(gatewayId, fixture.mqttCaPem, async () => {
      throw new Error("certificate request must not run");
    })).resolves.toBe(false);
  });

  it("reissues when the current identity is missing its MQTT server trust", async () => {
    const fixture = await createFixture();
    const gatewayId = "gateway-27";
    const issue = async (csrPem: string) => ({ gatewayId, ...(await signCsr(fixture.directory, csrPem, gatewayId)) });
    await fixture.store.ensure(gatewayId, fixture.mqttCaPem, issue);
    const currentTarget = await readlink(join(fixture.identityRoot, "current"));
    await rm(join(fixture.identityRoot, currentTarget, "mqtt-ca.crt"));

    await expect(fixture.store.ensure(gatewayId, fixture.mqttCaPem, issue)).resolves.toBe(true);
  });

  it("keeps the previous current identity when a replacement has the wrong CN", async () => {
    const fixture = await createFixture();
    const gatewayId = "gateway-27";
    await fixture.store.ensure(gatewayId, fixture.mqttCaPem, async (csrPem) => ({
      gatewayId,
      ...(await signCsr(fixture.directory, csrPem, gatewayId))
    }));
    const previous = await readlink(join(fixture.identityRoot, "current"));

    await expect(fixture.store.ensure("gateway-28", fixture.mqttCaPem, async () => ({
      gatewayId: "gateway-28",
      ...(await signWrongCommonNameCsr(fixture.directory, fixture.identityRoot, "gateway-not-assigned"))
    }))).rejects.toThrow("MQTT identity validation failed");

    await expect(readlink(join(fixture.identityRoot, "current"))).resolves.toBe(previous);
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-mqtt-identity-"));
  const identityRoot = join(directory, "identity", "mqtt");
  const mqttCaPem = await createCa(directory, "mqtt-server");
  return { directory, identityRoot, mqttCaPem, store: new MqttIdentityStore({ identityRoot }) };
}

async function signWrongCommonNameCsr(directory: string, identityRoot: string, commonName: string) {
  const pendingRoot = join(identityRoot, "pending-generations");
  const pending = (await readdir(pendingRoot)).find((name) => !name.startsWith("."));
  if (!pending) throw new Error("pending identity is missing");
  const csrPath = join(directory, "wrong-common-name.csr");
  await execFile("openssl", [
    "req", "-new", "-key", join(pendingRoot, pending, "gateway.key"), "-out", csrPath, "-subj", `/CN=${commonName}`
  ]);
  return signCsr(directory, await readFile(csrPath, "utf8"), "wrong-common-name");
}

async function createCa(directory: string, name: string) {
  const keyPath = join(directory, `${name}.key`);
  const certificatePath = join(directory, `${name}.crt`);
  await execFile("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", keyPath, "-out", certificatePath, "-subj", `/CN=${name} CA`, "-days", "1", "-sha256"
  ]);
  return readFile(certificatePath, "utf8");
}

async function signCsr(directory: string, csrPem: string, commonName: string) {
  const prefix = join(directory, `issuer-${commonName}`);
  const csrPath = `${prefix}.csr`;
  const caKeyPath = `${prefix}.key`;
  const caPath = `${prefix}.crt`;
  const certificatePath = `${prefix}-gateway.crt`;
  await writeFile(csrPath, csrPem);
  await execFile("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", caKeyPath, "-out", caPath, "-subj", `/CN=${commonName} issuer`, "-days", "1", "-sha256"
  ]);
  await execFile("openssl", [
    "x509", "-req", "-in", csrPath, "-CA", caPath, "-CAkey", caKeyPath,
    "-CAcreateserial", "-out", certificatePath, "-days", "1", "-sha256"
  ]);
  return {
    certificatePem: await readFile(certificatePath, "utf8"),
    caChainPem: [await readFile(caPath, "utf8")],
    notAfter: new Date(Date.now() + 86_400_000).toISOString()
  };
}
