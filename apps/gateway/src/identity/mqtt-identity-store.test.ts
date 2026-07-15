import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
    expect((await stat(generationPath)).mode & 0o777).toBe(0o750);
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
    await expectNoCandidateGenerations(fixture.identityRoot, previous);
  });

  it("removes the pending generation when the certificate API rejects", async () => {
    const fixture = await createFixture();
    const gatewayId = "gateway-27";
    await activateIdentity(fixture, gatewayId);
    const previous = await readlink(join(fixture.identityRoot, "current"));
    const syncs: string[] = [];
    const store = new MqttIdentityStore({
      identityRoot: fixture.identityRoot,
      syncDirectory: async (path) => { syncs.push(path); }
    });

    await expect(store.ensure("gateway-28", fixture.mqttCaPem, async () => {
      throw new Error("API rejected request");
    })).rejects.toThrow("MQTT identity installation failed");

    await expect(readlink(join(fixture.identityRoot, "current"))).resolves.toBe(previous);
    await expectNoCandidateGenerations(fixture.identityRoot, previous);
    expect(syncs.at(-1)).toBe(join(fixture.identityRoot, "pending-generations"));
  });

  it("removes the active candidate and preserves current when pointer replacement fails", async () => {
    const fixture = await createFixture();
    const gatewayId = "gateway-27";
    await activateIdentity(fixture, gatewayId);
    const previous = await readlink(join(fixture.identityRoot, "current"));
    const syncs: string[] = [];
    const failingStore = new MqttIdentityStore({
      identityRoot: fixture.identityRoot,
      rename: async (source, destination) => {
        if (destination === join(fixture.identityRoot, "current")) throw new Error("simulated pointer failure");
        await rename(source, destination);
      },
      syncDirectory: async (path) => { syncs.push(path); }
    });

    await expect(failingStore.ensure("gateway-28", fixture.mqttCaPem, async (csrPem) => ({
      gatewayId: "gateway-28",
      ...(await signCsr(fixture.directory, csrPem, "gateway-28"))
    }))).rejects.toThrow("MQTT identity installation failed");

    await expect(readlink(join(fixture.identityRoot, "current"))).resolves.toBe(previous);
    await expectNoCandidateGenerations(fixture.identityRoot, previous);
    expect(syncs.at(-1)).toBe(join(fixture.identityRoot, "generations"));
  });

  it.each([
    { name: "private key", target: (path: string) => join(path, "gateway.key"), mode: 0o644 },
    { name: "certificate", target: (path: string) => join(path, "gateway.crt"), mode: 0o600 },
    { name: "issuer chain", target: (path: string) => join(path, "gateway-chain.crt"), mode: 0o600 },
    { name: "MQTT CA", target: (path: string) => join(path, "mqtt-ca.crt"), mode: 0o600 },
    { name: "generation directory", target: (path: string) => path, mode: 0o755 }
  ])("fails closed instead of reusing an identity with an unsafe $name mode", async ({ target, mode }) => {
    const fixture = await createFixture();
    const gatewayId = "gateway-27";
    await activateIdentity(fixture, gatewayId);
    const currentTarget = await readlink(join(fixture.identityRoot, "current"));
    await chmod(target(join(fixture.identityRoot, currentTarget)), mode);
    const issue = async () => {
      throw new Error("certificate request must not run");
    };

    await expect(fixture.store.ensure(gatewayId, fixture.mqttCaPem, issue)).rejects.toThrow("MQTT identity permissions are invalid");
    expect(await readlink(join(fixture.identityRoot, "current"))).toBe(currentTarget);
  });

  it("rejects a response whose notAfter metadata differs from the leaf certificate before activation", async () => {
    const fixture = await createFixture();
    const gatewayId = "gateway-27";
    await activateIdentity(fixture, gatewayId);
    const previous = await readlink(join(fixture.identityRoot, "current"));

    await expect(fixture.store.ensure("gateway-28", fixture.mqttCaPem, async (csrPem) => ({
      gatewayId: "gateway-28",
      ...(await signCsr(fixture.directory, csrPem, "gateway-28")),
      notAfter: "2099-01-01T00:00:00.000Z"
    }))).rejects.toThrow("MQTT identity validation failed");

    await expect(readlink(join(fixture.identityRoot, "current"))).resolves.toBe(previous);
    await expectNoCandidateGenerations(fixture.identityRoot, previous);
  });

  it.each([
    { name: "expired", startOffsetDays: -3, endOffsetDays: -2 },
    { name: "not yet valid", startOffsetDays: 1, endOffsetDays: 2 }
  ])("rejects an $name leaf through OpenSSL verification before activation", async ({ startOffsetDays, endOffsetDays }) => {
    const fixture = await createFixture();
    const gatewayId = "gateway-27";
    await activateIdentity(fixture, gatewayId);
    const previous = await readlink(join(fixture.identityRoot, "current"));
    await expect(fixture.store.ensure("gateway-28", fixture.mqttCaPem, async (csrPem) => ({
      gatewayId: "gateway-28",
      ...(await signCsrWithValidity(
        fixture.directory,
        csrPem,
        "gateway-28",
        daysFromNow(startOffsetDays),
        daysFromNow(endOffsetDays)
      ))
    }))).rejects.toThrow("MQTT identity validation failed");

    await expect(readlink(join(fixture.identityRoot, "current"))).resolves.toBe(previous);
    await expectNoCandidateGenerations(fixture.identityRoot, previous);
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-mqtt-identity-"));
  const identityRoot = join(directory, "identity", "mqtt");
  const mqttCaPem = await createCa(directory, "mqtt-server");
  return { directory, identityRoot, mqttCaPem, store: new MqttIdentityStore({ identityRoot }) };
}

async function activateIdentity(fixture: Awaited<ReturnType<typeof createFixture>>, gatewayId: string) {
  await fixture.store.ensure(gatewayId, fixture.mqttCaPem, async (csrPem) => ({
    gatewayId,
    ...(await signCsr(fixture.directory, csrPem, gatewayId))
  }));
}

async function expectNoCandidateGenerations(identityRoot: string, currentTarget: string) {
  const pending = await readdir(join(identityRoot, "pending-generations"));
  const generations = await readdir(join(identityRoot, "generations"));
  expect(pending).toEqual([]);
  expect(generations).toEqual([basename(currentTarget)]);
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
    notAfter: await certificateNotAfter(certificatePath)
  };
}

async function certificateNotAfter(certificatePath: string) {
  const { stdout } = await execFile("openssl", ["x509", "-in", certificatePath, "-enddate", "-noout"]);
  const value = stdout.trim().replace(/^notAfter=/, "");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("certificate did not have a valid notAfter");
  return date.toISOString();
}

async function signCsrWithValidity(directory: string, csrPem: string, commonName: string, startDate: Date, endDate: Date) {
  const prefix = join(directory, `validity-${commonName}-${startDate.getTime()}`);
  const csrPath = `${prefix}.csr`;
  const caKeyPath = `${prefix}.key`;
  const caPath = `${prefix}.crt`;
  const certificatePath = `${prefix}-gateway.crt`;
  const databasePath = `${prefix}.index`;
  const serialPath = `${prefix}.serial`;
  const newCertificatesPath = `${prefix}-newcerts`;
  const configPath = `${prefix}.cnf`;
  await writeFile(csrPath, csrPem);
  await execFile("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", caKeyPath, "-out", caPath, "-subj", `/CN=${commonName} validity issuer`, "-days", "7", "-sha256"
  ]);
  await mkdir(newCertificatesPath);
  await writeFile(databasePath, "");
  await writeFile(serialPath, "01\n");
  await writeFile(configPath, `[ca]\ndefault_ca = issuer\n[issuer]\ndatabase = ${databasePath}\nnew_certs_dir = ${newCertificatesPath}\ncertificate = ${caPath}\nprivate_key = ${caKeyPath}\nserial = ${serialPath}\ndefault_md = sha256\ndefault_days = 1\npolicy = policy_any\n[policy_any]\ncommonName = supplied\n`);
  await execFile("openssl", [
    "ca", "-batch", "-config", configPath, "-in", csrPath, "-out", certificatePath,
    "-startdate", opensslDate(startDate), "-enddate", opensslDate(endDate)
  ]);
  return {
    certificatePem: await readFile(certificatePath, "utf8"),
    caChainPem: [await readFile(caPath, "utf8")],
    notAfter: await certificateNotAfter(certificatePath)
  };
}

function daysFromNow(days: number) {
  return new Date(Date.now() + days * 86_400_000);
}

function opensslDate(date: Date) {
  return date.toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}Z$/, "Z");
}
