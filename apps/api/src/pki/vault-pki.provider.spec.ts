import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { VaultPkiProvider, type VaultPkiProviderOptions } from "./vault-pki.provider";

const certificatePem = rootCertificates[0];
const certificate = new X509Certificate(certificatePem);

describe("VaultPkiProvider", () => {
  let temporaryDirectory: string;
  let tokenFile: string;
  let server: Server | undefined;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "vault-pki-provider-"));
    tokenFile = join(temporaryDirectory, "token");
    await writeFile(tokenFile, "token-one\n", { mode: 0o600 });
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it.each([
    ["device", "/v1/device-pki/sign/gateway-device"],
    ["mqtt", "/v1/mqtt-pki/sign/gateway-mqtt"]
  ] as const)("uses the fixed %s mount and role", async (purpose, expectedPath) => {
    const requests: CapturedRequest[] = [];
    const address = await startServer((request, response) => {
      captureRequest(request).then((captured) => {
        requests.push(captured);
        respondWithCertificate(response);
      });
    });
    const provider = new VaultPkiProvider(options(address, tokenFile));

    await provider.signCsr({
      purpose,
      csrPem: "SECRET-CSR",
      commonName: "gateway-1",
      uriSans: ["urn:dfkorea:gateway:gateway-1"],
      ttlSeconds: 900
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: expectedPath,
      body: {
        csr: "SECRET-CSR",
        common_name: "gateway-1",
        uri_sans: ["urn:dfkorea:gateway:gateway-1"],
        ttl: "900s",
        format: "pem"
      }
    });
  });

  it("reads the token file for every request and sends an optional namespace", async () => {
    const headers: Array<{ token: string | undefined; namespace: string | undefined }> = [];
    const address = await startServer((request, response) => {
      headers.push({
        token: request.headers["x-vault-token"] as string | undefined,
        namespace: request.headers["x-vault-namespace"] as string | undefined
      });
      request.resume();
      respondWithCertificate(response);
    });
    const provider = new VaultPkiProvider({ ...options(address, tokenFile), namespace: "factory/team-a" });

    await provider.signCsr(signInput());
    await writeFile(tokenFile, "token-two\n", { mode: 0o600 });
    await provider.signCsr(signInput());

    expect(headers).toEqual([
      { token: "token-one", namespace: "factory/team-a" },
      { token: "token-two", namespace: "factory/team-a" }
    ]);
  });

  it("derives missing certificate metadata with X509Certificate", async () => {
    const address = await startServer((request, response) => {
      request.resume();
      respondWithCertificate(response, { serial_number: undefined });
    });
    const provider = new VaultPkiProvider(options(address, tokenFile));

    await expect(provider.signCsr(signInput())).resolves.toEqual({
      certificatePem,
      caChainPem: [certificatePem],
      certificateSerial: certificate.serialNumber,
      fingerprint: certificate.fingerprint256,
      issuer: certificate.issuer,
      notBefore: new Date(certificate.validFrom).toISOString(),
      notAfter: new Date(certificate.validTo).toISOString()
    });
  });

  it("posts a validated serial in the revoke body rather than the URL", async () => {
    let captured: CapturedRequest | undefined;
    const address = await startServer((request, response) => {
      captureRequest(request).then((requestData) => {
        captured = requestData;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { revocation_time: 123 } }));
      });
    });
    const provider = new VaultPkiProvider(options(address, tokenFile));

    await provider.revoke({
      purpose: "mqtt",
      certificateSerial: "aa:BB:01",
      issuer: "CN=MQTT Issuing CA",
      fingerprint: "AA:BB:CC"
    });

    expect(captured).toMatchObject({
      method: "POST",
      url: "/v1/mqtt-pki/revoke",
      body: { serial_number: "aa:BB:01" }
    });
    await expect(
      provider.revoke({
        purpose: "mqtt",
        certificateSerial: "aa/../../revoke",
        issuer: "CN=MQTT Issuing CA",
        fingerprint: "AA:BB:CC"
      })
    ).rejects.toThrow("certificate serial must be colon- or hyphen-separated hexadecimal");
  });

  it("redacts Vault response bodies and request secrets from errors", async () => {
    const address = await startServer((request, response) => {
      request.resume();
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ errors: ["SECRET-RESPONSE-BODY", "token-one", "SECRET-CSR"] }));
    });
    const provider = new VaultPkiProvider(options(address, tokenFile));

    const error = await captureError(provider.signCsr(signInput()));

    expect(error.message).toBe("Vault PKI request failed with status 403");
    expect(error.message).not.toMatch(/SECRET|token-one|BEGIN CERTIFICATE/);
  });

  it("aborts requests that exceed the configured timeout", async () => {
    const address = await startServer((request) => request.resume());
    const provider = new VaultPkiProvider({ ...options(address, tokenFile), requestTimeoutMs: 20 });

    await expect(provider.signCsr(signInput())).rejects.toThrow("Vault PKI request timed out");
  });

  it("rejects mount and role values that could alter the Vault path", () => {
    const base = options("http://127.0.0.1:8200", tokenFile);

    expect(() => new VaultPkiProvider({ ...base, device: { mount: "pki/issuer", role: "device" } })).toThrow(
      "device mount must be a single Vault path segment"
    );
    expect(() => new VaultPkiProvider({ ...base, mqtt: { mount: "pki", role: "../admin" } })).toThrow(
      "mqtt role must be a single Vault path segment"
    );
  });

  function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
    server = createServer(handler);
    return new Promise((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", () => {
        const boundAddress = server?.address();
        if (!boundAddress || typeof boundAddress === "string") return reject(new Error("test server did not bind"));
        resolve(`http://127.0.0.1:${boundAddress.port}`);
      });
    });
  }
});

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  body: Record<string, unknown>;
}

async function captureRequest(request: IncomingMessage): Promise<CapturedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return {
    method: request.method,
    url: request.url,
    body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
  };
}

function respondWithCertificate(response: ServerResponse, overrides: Record<string, unknown> = {}) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      data: {
        certificate: certificatePem,
        ca_chain: [certificatePem],
        serial_number: "01:02:03",
        ...overrides
      }
    })
  );
}

function options(address: string, tokenPath: string): VaultPkiProviderOptions {
  return {
    address,
    tokenFile: tokenPath,
    requestTimeoutMs: 1_000,
    requireHttps: false,
    device: { mount: "device-pki", role: "gateway-device" },
    mqtt: { mount: "mqtt-pki", role: "gateway-mqtt" }
  };
}

function signInput() {
  return {
    purpose: "device" as const,
    csrPem: "SECRET-CSR",
    commonName: "gateway-1",
    uriSans: ["urn:dfkorea:gateway:gateway-1"],
    ttlSeconds: 900
  };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  const result: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error
  );
  if (!(result instanceof Error)) throw new Error("expected promise to reject with an Error");
  return result;
}
