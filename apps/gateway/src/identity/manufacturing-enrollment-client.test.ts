import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ManufacturingEnrollmentClient } from "./manufacturing-enrollment-client";

const execFile = promisify(execFileCallback);
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("ManufacturingEnrollmentClient", () => {
  it("posts token, serial, and CSR exactly once and returns the one-time Claim Code", async () => {
    const tls = await createTlsFixture();
    const token = "token-once-very-secret";
    const csrPem = "-----BEGIN CERTIFICATE REQUEST-----\nCSR-SECRET\n-----END CERTIFICATE REQUEST-----";
    let requestBody = "";
    const response = {
      deviceCertificatePem: "-----BEGIN CERTIFICATE-----\nDEVICE\n-----END CERTIFICATE-----",
      deviceCaBundlePem: "-----BEGIN CERTIFICATE-----\nDEVICE-CA\n-----END CERTIFICATE-----",
      apiCaBundlePem: "-----BEGIN CERTIFICATE-----\nAPI\n-----END CERTIFICATE-----",
      mqttCaBundlePem: "-----BEGIN CERTIFICATE-----\nMQTT\n-----END CERTIFICATE-----",
      claimCode: "claim-code-return-once"
    };
    const server = await listen(createServer({ key: tls.serverKey, cert: tls.serverCertificate }, (request, reply) => {
      request.on("data", (chunk) => { requestBody += chunk.toString(); });
      request.on("end", () => {
        reply.writeHead(200, { "content-type": "application/json" });
        reply.end(JSON.stringify(response));
      });
    }));
    const client = new ManufacturingEnrollmentClient({
      url: `https://localhost:${addressPort(server)}/gateway-manufacturing/enroll`,
      factoryCaPath: tls.caPath
    });

    await expect(client.enroll({ serialNumber: "GW-RPI-000001", token, csrPem })).resolves.toEqual(response);
    expect(JSON.parse(requestBody)).toEqual({ serialNumber: "GW-RPI-000001", token, csrPem });
    expect(requestBody.split(token)).toHaveLength(2);
    expect(requestBody.split(JSON.stringify(csrPem))).toHaveLength(2);
  });

  it("uses HTTPS hostname verification against only the factory API CA", async () => {
    const tls = await createTlsFixture();
    const server = await listen(createServer({ key: tls.serverKey, cert: tls.serverCertificate }, (_request, reply) => {
      reply.end("{}");
    }));
    const client = new ManufacturingEnrollmentClient({
      url: `https://127.0.0.1:${addressPort(server)}/gateway-manufacturing/enroll`,
      factoryCaPath: tls.caPath
    });

    await expect(client.enroll(validRequest())).rejects.toThrow("manufacturing enrollment failed");
  });

  it("limits response size and never exposes response credentials in errors", async () => {
    const tls = await createTlsFixture();
    const sensitiveBody = JSON.stringify({
      token: "token-secret",
      csrPem: "CSR-SECRET",
      deviceCertificatePem: "CERT-SECRET",
      deviceCaBundlePem: "DEVICE-CA-SECRET",
      claimCode: "CLAIM-SECRET",
      vault: "VAULT-BODY"
    });
    const server = await listen(createServer({ key: tls.serverKey, cert: tls.serverCertificate }, (_request, reply) => {
      reply.writeHead(500, { "content-type": "application/json" });
      reply.end(sensitiveBody.repeat(10));
    }));
    const client = new ManufacturingEnrollmentClient({
      url: `https://localhost:${addressPort(server)}/gateway-manufacturing/enroll`,
      factoryCaPath: tls.caPath,
      maxResponseBytes: 64
    });

    const error = await captureError(client.enroll(validRequest()));
    expect(error.message).toBe("manufacturing enrollment failed");
    expect(error.message).not.toMatch(/token-secret|CSR-SECRET|CERT-SECRET|DEVICE-CA-SECRET|CLAIM-SECRET|VAULT-BODY/);
  });

  it("rejects private device CA material without exposing it", async () => {
    const tls = await createTlsFixture();
    const privateMaterial = "-----BEGIN PRIVATE KEY-----\nDEVICE-CA-PRIVATE\n-----END PRIVATE KEY-----";
    const server = await listen(createServer({ key: tls.serverKey, cert: tls.serverCertificate }, (_request, reply) => {
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify({
        deviceCertificatePem: "-----BEGIN CERTIFICATE-----\nDEVICE\n-----END CERTIFICATE-----",
        deviceCaBundlePem: privateMaterial,
        apiCaBundlePem: "-----BEGIN CERTIFICATE-----\nAPI\n-----END CERTIFICATE-----",
        mqttCaBundlePem: "-----BEGIN CERTIFICATE-----\nMQTT\n-----END CERTIFICATE-----",
        claimCode: "claim-code"
      }));
    }));
    const client = new ManufacturingEnrollmentClient({
      url: `https://localhost:${addressPort(server)}/gateway-manufacturing/enroll`,
      factoryCaPath: tls.caPath
    });

    const error = await captureError(client.enroll(validRequest()));
    expect(error.message).toBe("manufacturing enrollment failed");
    expect(error.message).not.toContain("DEVICE-CA-PRIVATE");
  });

  it("aborts requests that exceed the configured timeout without leaking the request", async () => {
    const tls = await createTlsFixture();
    const server = await listen(createServer({ key: tls.serverKey, cert: tls.serverCertificate }, () => undefined));
    const client = new ManufacturingEnrollmentClient({
      url: `https://localhost:${addressPort(server)}/gateway-manufacturing/enroll`,
      factoryCaPath: tls.caPath,
      timeoutMs: 30
    });

    const error = await captureError(client.enroll(validRequest()));
    expect(error.message).toBe("manufacturing enrollment failed");
    expect(error.message).not.toContain(validRequest().token);
  });
});

function validRequest() {
  return {
    serialNumber: "GW-RPI-000001",
    token: "enrollment-token-secret",
    csrPem: "-----BEGIN CERTIFICATE REQUEST-----\nCSR\n-----END CERTIFICATE REQUEST-----"
  };
}

async function createTlsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-enrollment-tls-"));
  const caPath = join(directory, "factory-ca.crt");
  const caKeyPath = join(directory, "factory-ca.key");
  const serverKeyPath = join(directory, "server.key");
  const serverCsrPath = join(directory, "server.csr");
  const serverCertificatePath = join(directory, "server.crt");
  const extensionPath = join(directory, "server.ext");
  const { writeFile } = await import("node:fs/promises");
  await execFile("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", caKeyPath, "-out", caPath, "-subj", "/CN=Factory API CA", "-days", "1", "-sha256"
  ]);
  await execFile("openssl", [
    "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", serverKeyPath, "-out", serverCsrPath, "-subj", "/CN=localhost", "-sha256"
  ]);
  await writeFile(extensionPath, "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n");
  await execFile("openssl", [
    "x509", "-req", "-in", serverCsrPath, "-CA", caPath, "-CAkey", caKeyPath,
    "-CAcreateserial", "-out", serverCertificatePath, "-days", "1", "-sha256", "-extfile", extensionPath
  ]);
  return {
    caPath,
    serverKey: await readFile(serverKeyPath),
    serverCertificate: await readFile(serverCertificatePath)
  };
}

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function addressPort(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return address.port;
}

async function captureError(promise: Promise<unknown>) {
  const result = await promise.then(
    () => null,
    (error: unknown) => error
  );
  if (!(result instanceof Error)) throw new Error("expected enrollment to fail");
  return result;
}
