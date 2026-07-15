import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import type { DeviceIdentityPaths } from "./key-material-store";

const MAX_CSR_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface DeviceCertificateResponse {
  gatewayId: string;
  certificatePem: string;
  caChainPem: string;
  notAfter: string;
}

export interface DeviceCertificateClientOptions {
  renewUrl: string;
  activateUrl: string;
  certificatePath: string;
  privateKeyPath: string;
  caPath: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  request?: (url: URL, body: Buffer, tls: TlsMaterial) => Promise<string>;
}

interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
}

export class DeviceCertificateClient {
  private readonly renewUrl: URL;
  private readonly activateUrl: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly send: (url: URL, body: Buffer, tls: TlsMaterial) => Promise<string>;

  constructor(private readonly options: DeviceCertificateClientOptions) {
    this.renewUrl = parseHttpsUrl(options.renewUrl);
    this.activateUrl = parseHttpsUrl(options.activateUrl);
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 1, 120_000);
    this.maxResponseBytes = boundedInteger(options.maxResponseBytes ?? MAX_RESPONSE_BYTES, 1, 1024 * 1024);
    this.send = options.request ?? ((url, body, tls) => this.post(url, body, tls));
  }

  async renew(csrPem: string): Promise<DeviceCertificateResponse> {
    try {
      validateCsr(csrPem);
      return parseResponse(await this.send(this.renewUrl, Buffer.from(JSON.stringify({ csrPem }), "utf8"), await this.currentTls()));
    } catch {
      throw new Error("device certificate renewal failed");
    }
  }

  async activate(candidate: Omit<DeviceIdentityPaths, "notAfter">): Promise<void> {
    try {
      await this.send(this.activateUrl, Buffer.alloc(0), await readTls(candidate.certificatePath, candidate.privateKeyPath, candidate.apiCaPath));
    } catch {
      throw new Error("device certificate activation failed");
    }
  }

  private currentTls() {
    return readTls(this.options.certificatePath, this.options.privateKeyPath, this.options.caPath);
  }

  private post(url: URL, body: Buffer, tls: TlsMaterial) {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const rejectOnce = () => {
        if (settled) return;
        settled = true;
        reject(new Error("request failed"));
      };
      const request = httpsRequest(url, {
        method: "POST", cert: tls.cert, key: tls.key, ca: tls.ca, rejectUnauthorized: true, checkServerIdentity,
        headers: { accept: "application/json", "content-type": "application/json", "content-length": body.byteLength }
      }, (response) => {
        const declaredLength = Number(response.headers["content-length"] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
          response.destroy();
          rejectOnce();
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > this.maxResponseBytes) {
            response.destroy();
            rejectOnce();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", rejectOnce);
        response.on("end", () => {
          if (settled) return;
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            rejectOnce();
            return;
          }
          settled = true;
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      });
      request.setTimeout(this.timeoutMs, () => request.destroy());
      request.on("error", rejectOnce);
      request.end(body);
    });
  }
}

async function readTls(certificatePath: string, privateKeyPath: string, caPath: string): Promise<TlsMaterial> {
  return Promise.all([readFile(certificatePath), readFile(privateKeyPath), readFile(caPath)]).then(([cert, key, ca]) => ({ cert, key, ca }));
}

function parseHttpsUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid device certificate URL");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new Error("invalid device certificate URL");
  }
  return url;
}

function validateCsr(value: string) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_CSR_BYTES ||
    !value.includes("-----BEGIN CERTIFICATE REQUEST-----") || value.includes("PRIVATE KEY")) {
    throw new Error("invalid CSR");
  }
}

function parseResponse(payload: string): DeviceCertificateResponse {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error("invalid response");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid response");
  const response = value as Record<string, unknown>;
  return {
    gatewayId: requiredText(response.gatewayId, 256),
    certificatePem: certificate(response.certificatePem),
    caChainPem: certificate(response.caChainPem),
    notAfter: validDate(response.notAfter)
  };
}

function certificate(value: unknown) {
  const pem = requiredText(value, MAX_RESPONSE_BYTES);
  if (!pem.includes("-----BEGIN CERTIFICATE-----") || pem.includes("PRIVATE KEY")) throw new Error("invalid response");
  return pem;
}

function validDate(value: unknown) {
  const date = requiredText(value, 128);
  if (Number.isNaN(new Date(date).getTime())) throw new Error("invalid response");
  return date;
}

function requiredText(value: unknown, maxBytes: number) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) throw new Error("invalid response");
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error("invalid option");
  return value;
}
