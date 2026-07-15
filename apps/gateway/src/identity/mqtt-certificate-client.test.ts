import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:https";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { MqttCertificateClient } from "./mqtt-certificate-client";

const execFile = promisify(execFileCallback);

describe("MqttCertificateClient", () => {
  it("posts only the MQTT CSR to the certificate endpoint using device mTLS", async () => {
    const tls = await createTlsFixture();
    const server = createServer({
      ca: await readFile(tls.caPath),
      cert: await readFile(tls.serverCertificatePath),
      key: await readFile(tls.serverKeyPath),
      requestCert: true,
      rejectUnauthorized: true
    }, async (request, response) => {
      expect((request.socket as TLSSocket).authorized).toBe(true);
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/gateway-certificates/mqtt");
      const body = await readBody(request);
      expect(JSON.parse(body)).toEqual({ csrPem: "-----BEGIN CERTIFICATE REQUEST-----\nMQTT-CSR\n-----END CERTIFICATE REQUEST-----" });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        gatewayId: "gateway-27",
        certificatePem: "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----",
        caChainPem: ["-----BEGIN CERTIFICATE-----\nISSUER\n-----END CERTIFICATE-----"],
        notAfter: "2026-10-13T00:00:00.000Z"
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    const client = new MqttCertificateClient({
      url: `https://localhost:${address.port}/gateway-certificates/mqtt`,
      certificatePath: tls.clientCertificatePath,
      privateKeyPath: tls.clientKeyPath,
      caPath: tls.caPath
    });

    await expect(client.requestCertificate("-----BEGIN CERTIFICATE REQUEST-----\nMQTT-CSR\n-----END CERTIFICATE REQUEST-----"))
      .resolves.toEqual({
        gatewayId: "gateway-27",
        certificatePem: "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----",
        caChainPem: ["-----BEGIN CERTIFICATE-----\nISSUER\n-----END CERTIFICATE-----"],
        notAfter: "2026-10-13T00:00:00.000Z"
      });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("rejects an invalid certificate response without exposing its contents", async () => {
    const tls = await createTlsFixture();
    const client = new MqttCertificateClient({
      url: "https://api.example/gateway-certificates/mqtt",
      certificatePath: tls.clientCertificatePath,
      privateKeyPath: tls.clientKeyPath,
      caPath: tls.caPath,
      request: async () => "{\"gatewayId\":\"gateway-27\"}"
    });

    await expect(client.requestCertificate("-----BEGIN CERTIFICATE REQUEST-----\nCSR\n-----END CERTIFICATE REQUEST-----"))
      .rejects.toThrow("MQTT certificate request failed");
  });
});

async function readBody(request: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function createTlsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-mqtt-client-"));
  const caPath = join(directory, "ca.crt");
  const caKeyPath = join(directory, "ca.key");
  const serverKeyPath = join(directory, "server.key");
  const serverCsrPath = join(directory, "server.csr");
  const serverCertificatePath = join(directory, "server.crt");
  const clientKeyPath = join(directory, "device.key");
  const clientCsrPath = join(directory, "device.csr");
  const clientCertificatePath = join(directory, "device.crt");
  const extPath = join(directory, "server.ext");
  await writeFile(extPath, "subjectAltName=DNS:localhost\n");
  await execFile("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", caKeyPath, "-out", caPath, "-subj", "/CN=Gateway test CA", "-days", "1", "-sha256"
  ]);
  await createSignedCertificate("server", serverKeyPath, serverCsrPath, serverCertificatePath, caPath, caKeyPath, ["-extfile", extPath]);
  await createSignedCertificate("device", clientKeyPath, clientCsrPath, clientCertificatePath, caPath, caKeyPath);
  return { caPath, serverKeyPath, serverCertificatePath, clientKeyPath, clientCertificatePath };
}

async function createSignedCertificate(
  commonName: string,
  keyPath: string,
  csrPath: string,
  certificatePath: string,
  caPath: string,
  caKeyPath: string,
  extra: string[] = []
) {
  await execFile("openssl", [
    "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", keyPath, "-out", csrPath, "-subj", `/CN=${commonName}`
  ]);
  await execFile("openssl", [
    "x509", "-req", "-in", csrPath, "-CA", caPath, "-CAkey", caKeyPath,
    "-CAcreateserial", "-out", certificatePath, "-days", "1", "-sha256", ...extra
  ]);
}
