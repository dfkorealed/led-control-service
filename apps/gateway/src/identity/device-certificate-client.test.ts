import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeviceCertificateClient } from "./device-certificate-client";

describe("DeviceCertificateClient", () => {
  it("accepts an array CA chain and returns each validated PEM in normalized form", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-device-client-"));
    const [certificatePath, privateKeyPath, caPath] = ["device.crt", "device.key", "api-ca.crt"].map((name) => join(directory, name));
    await Promise.all([
      writeFile(certificatePath, "certificate"), writeFile(privateKeyPath, "key"), writeFile(caPath, "ca")
    ]);
    const client = new DeviceCertificateClient({
      renewUrl: "https://api.example/gateway-certificates/device/renew",
      activateUrl: "https://api.example/gateway-certificates/device/activate",
      certificatePath,
      privateKeyPath,
      caPath,
      request: async () => JSON.stringify({
        gatewayId: "gateway-27",
        certificatePem: "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
        caChainPem: [
          "\r\n-----BEGIN CERTIFICATE-----\r\nISSUER\r\n-----END CERTIFICATE-----\r\n",
          "-----BEGIN CERTIFICATE-----\nROOT\n-----END CERTIFICATE-----\n"
        ],
        notAfter: "2026-10-01T00:00:00.000Z"
      })
    });

    await expect(client.renew("-----BEGIN CERTIFICATE REQUEST-----\nCSR\n-----END CERTIFICATE REQUEST-----"))
      .resolves.toMatchObject({
        gatewayId: "gateway-27",
        caChainPem: [
          "-----BEGIN CERTIFICATE-----\nISSUER\n-----END CERTIFICATE-----\n",
          "-----BEGIN CERTIFICATE-----\nROOT\n-----END CERTIFICATE-----\n"
        ]
      });
  });

  it("retries activation with the same candidate when the first response is lost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-device-client-"));
    const [certificatePath, privateKeyPath, caPath] = ["device.crt", "device.key", "api-ca.crt"].map((name) => join(directory, name));
    await Promise.all([
      writeFile(certificatePath, "certificate"), writeFile(privateKeyPath, "key"), writeFile(caPath, "ca")
    ]);
    let requests = 0;
    const client = new DeviceCertificateClient({
      renewUrl: "https://api.example/gateway-certificates/device/renew",
      activateUrl: "https://api.example/gateway-certificates/device/activate",
      certificatePath,
      privateKeyPath,
      caPath,
      request: async () => {
        requests += 1;
        if (requests === 1) throw new Error("response lost");
        return JSON.stringify({ status: "active" });
      }
    });

    await expect(client.activate({
      generationPath: directory,
      certificatePath,
      privateKeyPath,
      deviceCaPath: caPath,
      apiCaPath: caPath,
      mqttCaPath: caPath
    })).resolves.toBeUndefined();
    expect(requests).toBe(2);
  });
});
