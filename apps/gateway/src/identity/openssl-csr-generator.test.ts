import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { OpenSslCsrGenerator } from "./openssl-csr-generator";

const execFile = promisify(execFileCallback);

describe("OpenSslCsrGenerator", () => {
  it("creates a PKCS#8 P-256 key and SHA-256 CSR without returning private material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-csr-"));
    const privateKeyPath = join(directory, "device.key");
    const csrPath = join(directory, "device.csr");

    const result = await new OpenSslCsrGenerator().generate({
      serialNumber: "GW-RPI-000001",
      privateKeyPath,
      csrPath
    });

    const privateKeyPem = await readFile(privateKeyPath, "utf8");
    const { stdout: keyDetails } = await execFile("openssl", ["pkey", "-in", privateKeyPath, "-text", "-noout"]);
    const { stdout: csrDetails } = await execFile("openssl", ["req", "-in", csrPath, "-text", "-noout"]);
    expect(privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(keyDetails).toContain("ASN1 OID: prime256v1");
    expect(csrDetails).not.toContain("sha256WithRSAEncryption");
    expect(csrDetails.toLowerCase()).toContain("sha256");
    expect(csrDetails).toMatch(/Subject: CN\s*=\s*GW-RPI-000001/);
    expect((await stat(privateKeyPath)).mode & 0o777).toBe(0o600);
    expect(result).toEqual({ csrPem: expect.stringContaining("BEGIN CERTIFICATE REQUEST") });
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });

  it("precreates the private key exclusively as mode 0600 before OpenSSL runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-csr-mode-"));
    const privateKeyPath = join(directory, "device.key");
    const csrPath = join(directory, "device.csr");
    const previousUmask = process.umask(0o000);
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "genpkey") {
        expect((await stat(privateKeyPath)).mode & 0o777).toBe(0o600);
      }
      await execFile("openssl", [...args]);
    });

    try {
      await new OpenSslCsrGenerator({ run }).generate({
        serialNumber: "GW-RPI-000001",
        privateKeyPath,
        csrPath
      });
    } finally {
      process.umask(previousUmask);
    }

    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([
    "GW/../../injected",
    "GW-RPI-1\n-subj /CN=attacker",
    "GW RPI 1",
    "-config",
    "a".repeat(129)
  ])("rejects unsafe serial %j before OpenSSL runs", async (serialNumber) => {
    const run = vi.fn();
    const generator = new OpenSslCsrGenerator({ run });

    await expect(generator.generate({
      serialNumber,
      privateKeyPath: "/tmp/device.key",
      csrPath: "/tmp/device.csr"
    })).rejects.toThrow("serialNumber has an invalid format");
    expect(run).not.toHaveBeenCalled();
  });

  it("uses fixed OpenSSL argument arrays and redacts process failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-csr-failure-"));
    const secret = "-----BEGIN PRIVATE KEY-----TOP-SECRET";
    const run = vi.fn().mockRejectedValue(new Error(secret));
    const generator = new OpenSslCsrGenerator({ run });

    await expect(generator.generate({
      serialNumber: "GW-RPI-000001",
      privateKeyPath: join(directory, "device.key"),
      csrPath: join(directory, "device.csr")
    })).rejects.toThrow("OpenSSL device identity generation failed");
    await expect(generator.generate({
      serialNumber: "GW-RPI-000001",
      privateKeyPath: join(directory, "device-2.key"),
      csrPath: join(directory, "device-2.csr")
    })).rejects.not.toThrow(secret);
    expect(run).toHaveBeenCalledWith([
      "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-out", join(directory, "device.key")
    ]);
  });

  it("declares shell=false in the production process runner", async () => {
    const source = await readFile(new URL("./openssl-csr-generator.ts", import.meta.url), "utf8");
    expect(source).toContain("shell: false");
    expect(source).not.toMatch(/\bexec\s*\(/);
  });
});
