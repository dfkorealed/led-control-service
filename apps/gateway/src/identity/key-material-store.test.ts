import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, readlink, rename, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { KeyMaterialStore } from "./key-material-store";

const execFile = promisify(execFileCallback);

describe("KeyMaterialStore", () => {
  it("activates one complete immutable generation with hardened permissions", async () => {
    const fixture = await createFixture();
    const generated = await fixture.store.generateDeviceIdentity("GW-RPI-000001");
    const signed = await signCsr(fixture.directory, generated.csrPem, "trusted");
    const apiTrust = await signCsr(fixture.directory, generated.csrPem, "api-server");
    const mqttTrust = await signCsr(fixture.directory, generated.csrPem, "mqtt-server");

    await fixture.store.installIdentityBundle({
      deviceCertificatePem: signed.certificatePem,
      deviceCaBundlePem: signed.caCertificatePem,
      apiCaBundlePem: apiTrust.caCertificatePem,
      mqttCaBundlePem: mqttTrust.caCertificatePem
    });

    const currentTarget = await readlink(join(fixture.identityRoot, "current"));
    const generationPath = join(fixture.identityRoot, currentTarget);
    expect(currentTarget).toMatch(/^generations\/[0-9a-f-]+$/);
    expect((await stat(fixture.identityRoot)).mode & 0o777).toBe(0o750);
    expect((await stat(generationPath)).mode & 0o777).toBe(0o750);
    expect((await stat(join(generationPath, "device.key"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(generationPath, "device.crt"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(generationPath, "device-ca.crt"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(generationPath, "api-ca.crt"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(generationPath, "mqtt-ca.crt"))).mode & 0o777).toBe(0o644);
    expect(JSON.stringify(generated)).not.toContain("PRIVATE KEY");
    await expect(readFile(join(generationPath, "device.key"), "utf8")).resolves.toContain("BEGIN PRIVATE KEY");
    await expect(execFile("openssl", [
      "verify", "-purpose", "sslclient", "-CAfile", join(generationPath, "device-ca.crt"),
      join(generationPath, "device.crt")
    ])).resolves.toMatchObject({ stdout: expect.stringContaining("OK") });
    await expect(execFile("openssl", [
      "verify", "-purpose", "sslclient", "-CAfile", join(generationPath, "api-ca.crt"),
      join(generationPath, "device.crt")
    ])).rejects.toMatchObject({ code: 2 });
    await expect(execFile("openssl", [
      "verify", "-purpose", "sslclient", "-CAfile", join(generationPath, "mqtt-ca.crt"),
      join(generationPath, "device.crt")
    ])).rejects.toMatchObject({ code: 2 });
  });

  it("does not expose a pending key through current before certificate installation", async () => {
    const fixture = await createFixture();
    await fixture.store.generateDeviceIdentity("GW-RPI-000001");

    await expect(readlink(join(fixture.identityRoot, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    const pendingTarget = await readlink(join(fixture.identityRoot, "pending"));
    expect(pendingTarget).toMatch(/^pending-generations\/[0-9a-f-]+$/);
  });

  it("rejects a symlinked identity root instead of writing key material outside its boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-identity-symlink-"));
    const externalDirectory = join(directory, "external");
    const identityRoot = join(directory, "identity");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(externalDirectory));
    await symlink(externalDirectory, identityRoot);

    await expect(new KeyMaterialStore({ identityRoot }).generateDeviceIdentity("GW-RPI-000001"))
      .rejects.toThrow("identity storage directory is invalid");
    expect(await readdir(externalDirectory)).toEqual([]);
  });

  it("preserves the active generation when a new certificate public key does not match its CSR", async () => {
    const fixture = await createFixture();
    const first = await fixture.store.generateDeviceIdentity("GW-RPI-000001");
    const firstSigned = await signCsr(fixture.directory, first.csrPem, "first");
    await fixture.store.installIdentityBundle({
      deviceCertificatePem: firstSigned.certificatePem,
      deviceCaBundlePem: firstSigned.caCertificatePem,
      apiCaBundlePem: firstSigned.caCertificatePem,
      mqttCaBundlePem: firstSigned.caCertificatePem
    });
    const activeBefore = await readlink(join(fixture.identityRoot, "current"));
    const keyBefore = await readFile(join(fixture.identityRoot, activeBefore, "device.key"), "utf8");

    await fixture.store.generateDeviceIdentity("GW-RPI-000001");
    await expect(fixture.store.installIdentityBundle({
      deviceCertificatePem: firstSigned.certificatePem,
      deviceCaBundlePem: firstSigned.caCertificatePem,
      apiCaBundlePem: firstSigned.caCertificatePem,
      mqttCaBundlePem: firstSigned.caCertificatePem
    })).rejects.toThrow("identity bundle validation failed");

    expect(await readlink(join(fixture.identityRoot, "current"))).toBe(activeBefore);
    expect(await readFile(join(fixture.identityRoot, activeBefore, "device.key"), "utf8")).toBe(keyBefore);
  });

  it("rejects an untrusted certificate chain before activation", async () => {
    const fixture = await createFixture();
    const generated = await fixture.store.generateDeviceIdentity("GW-RPI-000001");
    const trusted = await signCsr(fixture.directory, generated.csrPem, "trusted-chain");
    const untrusted = await signCsr(fixture.directory, generated.csrPem, "untrusted-chain");

    await expect(fixture.store.installIdentityBundle({
      deviceCertificatePem: untrusted.certificatePem,
      deviceCaBundlePem: trusted.caCertificatePem,
      apiCaBundlePem: trusted.caCertificatePem,
      mqttCaBundlePem: trusted.caCertificatePem
    })).rejects.toThrow("identity bundle validation failed");
    await expect(readlink(join(fixture.identityRoot, "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the previous current pointer when its atomic replacement fails", async () => {
    const fixture = await createFixture();
    const first = await fixture.store.generateDeviceIdentity("GW-RPI-000001");
    const firstSigned = await signCsr(fixture.directory, first.csrPem, "active");
    await fixture.store.installIdentityBundle({
      deviceCertificatePem: firstSigned.certificatePem,
      deviceCaBundlePem: firstSigned.caCertificatePem,
      apiCaBundlePem: firstSigned.caCertificatePem,
      mqttCaBundlePem: firstSigned.caCertificatePem
    });
    const activeBefore = await readlink(join(fixture.identityRoot, "current"));

    const second = await fixture.store.generateDeviceIdentity("GW-RPI-000001");
    const secondSigned = await signCsr(fixture.directory, second.csrPem, "replacement");
    const failingStore = new KeyMaterialStore({
      identityRoot: fixture.identityRoot,
      rename: async (source, destination) => {
        if (destination === join(fixture.identityRoot, "current")) throw new Error("simulated rename failure");
        await rename(source, destination);
      }
    });

    await expect(failingStore.installIdentityBundle({
      deviceCertificatePem: secondSigned.certificatePem,
      deviceCaBundlePem: secondSigned.caCertificatePem,
      apiCaBundlePem: secondSigned.caCertificatePem,
      mqttCaBundlePem: secondSigned.caCertificatePem
    })).rejects.toThrow("identity activation failed");
    expect(await readlink(join(fixture.identityRoot, "current"))).toBe(activeBefore);
  });

  it("restores the previous current and returns the new generation to pending after current directory sync fails", async () => {
    const fixture = await createFixture();
    const first = await fixture.store.generateDeviceIdentity("GW-RPI-000001");
    const firstSigned = await signCsr(fixture.directory, first.csrPem, "sync-active");
    await fixture.store.installIdentityBundle(bundleFrom(firstSigned));
    const activeBefore = await readlink(join(fixture.identityRoot, "current"));

    const second = await fixture.store.generateDeviceIdentity("GW-RPI-000001");
    const secondSigned = await signCsr(fixture.directory, second.csrPem, "sync-replacement");
    let identityRootSyncs = 0;
    const failingStore = new KeyMaterialStore({
      identityRoot: fixture.identityRoot,
      syncDirectory: async (path) => {
        if (path === fixture.identityRoot && ++identityRootSyncs === 1) {
          throw new Error("simulated current directory sync failure");
        }
      }
    });

    await expect(failingStore.installIdentityBundle(bundleFrom(secondSigned)))
      .rejects.toThrow("identity activation failed");

    expect(await readlink(join(fixture.identityRoot, "current"))).toBe(activeBefore);
    const pendingTarget = await readlink(join(fixture.identityRoot, "pending"));
    expect(pendingTarget).toMatch(/^pending-generations\/[0-9a-f-]+$/);
    await expect(stat(join(fixture.identityRoot, pendingTarget, "device.key"))).resolves.toBeDefined();
  });

  it("preserves the new active generation when current rollback itself fails", async () => {
    const fixture = await createFixture();
    const first = await fixture.store.generateDeviceIdentity("GW-RPI-000001");
    const firstSigned = await signCsr(fixture.directory, first.csrPem, "rollback-active");
    await fixture.store.installIdentityBundle(bundleFrom(firstSigned));

    const second = await fixture.store.generateDeviceIdentity("GW-RPI-000001");
    const secondSigned = await signCsr(fixture.directory, second.csrPem, "rollback-replacement");
    let currentRenames = 0;
    let identityRootSyncs = 0;
    const failingStore = new KeyMaterialStore({
      identityRoot: fixture.identityRoot,
      rename: async (source, destination) => {
        if (destination === join(fixture.identityRoot, "current") && ++currentRenames === 2) {
          throw new Error("simulated current rollback failure");
        }
        await rename(source, destination);
      },
      syncDirectory: async (path) => {
        if (path === fixture.identityRoot && ++identityRootSyncs === 1) {
          throw new Error("simulated current directory sync failure");
        }
      }
    });

    await expect(failingStore.installIdentityBundle(bundleFrom(secondSigned)))
      .rejects.toThrow(/^identity activation failed$/);

    const currentTarget = await readlink(join(fixture.identityRoot, "current"));
    expect(currentTarget).toMatch(/^generations\/[0-9a-f-]+$/);
    await expect(stat(join(fixture.identityRoot, currentTarget, "device.key"))).resolves.toBeDefined();
  });

  it("does not leave a dangling current after first activation directory sync fails", async () => {
    const fixture = await createFixture();
    const generated = await fixture.store.generateDeviceIdentity("GW-RPI-000001");
    const signed = await signCsr(fixture.directory, generated.csrPem, "first-sync-failure");
    let identityRootSyncs = 0;
    const failingStore = new KeyMaterialStore({
      identityRoot: fixture.identityRoot,
      syncDirectory: async (path) => {
        if (path === fixture.identityRoot && ++identityRootSyncs === 1) {
          throw new Error("simulated current directory sync failure");
        }
      }
    });

    await expect(failingStore.installIdentityBundle(bundleFrom(signed)))
      .rejects.toThrow("identity activation failed");

    await expect(readlink(join(fixture.identityRoot, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    const pendingTarget = await readlink(join(fixture.identityRoot, "pending"));
    await expect(stat(join(fixture.identityRoot, pendingTarget, "device.key"))).resolves.toBeDefined();
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-identity-"));
  const identityRoot = join(directory, "identity");
  return { directory, identityRoot, store: new KeyMaterialStore({ identityRoot }) };
}

async function signCsr(directory: string, csrPem: string, name: string) {
  const prefix = join(directory, name);
  const csrPath = `${prefix}.csr`;
  const caKeyPath = `${prefix}-ca.key`;
  const caPath = `${prefix}-ca.crt`;
  const certificatePath = `${prefix}-device.crt`;
  await import("node:fs/promises").then(({ writeFile }) => writeFile(csrPath, csrPem));
  await execFile("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", caKeyPath, "-out", caPath, "-subj", `/CN=${basename(prefix)} CA`, "-days", "1", "-sha256"
  ]);
  await execFile("openssl", [
    "x509", "-req", "-in", csrPath, "-CA", caPath, "-CAkey", caKeyPath,
    "-CAcreateserial", "-out", certificatePath, "-days", "1", "-sha256"
  ]);
  return {
    certificatePem: await readFile(certificatePath, "utf8"),
    caCertificatePem: await readFile(caPath, "utf8")
  };
}

function bundleFrom(signed: { certificatePem: string; caCertificatePem: string }) {
  return {
    deviceCertificatePem: signed.certificatePem,
    deviceCaBundlePem: signed.caCertificatePem,
    apiCaBundlePem: signed.caCertificatePem,
    mqttCaBundlePem: signed.caCertificatePem
  };
}
