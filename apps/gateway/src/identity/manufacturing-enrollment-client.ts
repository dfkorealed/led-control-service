import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_FACTORY_CA_BYTES = 256 * 1024;
const SERIAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ManufacturingEnrollmentRequest {
  serialNumber: string;
  token: string;
  csrPem: string;
}

export interface ManufacturingEnrollmentResponse {
  deviceCertificatePem: string;
  deviceCaBundlePem: string;
  apiCaBundlePem: string;
  mqttCaBundlePem: string;
  claimCode: string;
}

export interface ManufacturingEnrollmentClientOptions {
  url: string;
  factoryCaPath: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class ManufacturingEnrollmentClient {
  private readonly url: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly factoryCaPath: string;

  constructor(options: ManufacturingEnrollmentClientOptions) {
    this.url = parseHttpsUrl(options.url);
    this.timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 120_000);
    this.maxResponseBytes = boundedInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 1, 1024 * 1024);
    this.factoryCaPath = options.factoryCaPath;
  }

  async enroll(input: ManufacturingEnrollmentRequest): Promise<ManufacturingEnrollmentResponse> {
    try {
      validateRequest(input);
      const ca = await readFactoryCa(this.factoryCaPath);
      const body = Buffer.from(JSON.stringify({
        serialNumber: input.serialNumber,
        token: input.token,
        csrPem: input.csrPem
      }), "utf8");
      const payload = await this.post(body, ca);
      return parseResponse(payload);
    } catch {
      throw new Error("manufacturing enrollment failed");
    }
  }

  private post(body: Buffer, ca: Buffer) {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const settleReject = () => {
        if (settled) return;
        settled = true;
        reject(new Error("request failed"));
      };
      const request = httpsRequest(
        this.url,
        {
          method: "POST",
          ca,
          rejectUnauthorized: true,
          checkServerIdentity,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "content-length": body.byteLength
          }
        },
        (response) => {
          const declaredLength = Number(response.headers["content-length"] ?? 0);
          if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
            response.destroy();
            settleReject();
            return;
          }
          const chunks: Buffer[] = [];
          let receivedBytes = 0;
          response.on("data", (chunk: Buffer) => {
            receivedBytes += chunk.byteLength;
            if (receivedBytes > this.maxResponseBytes) {
              response.destroy();
              settleReject();
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", settleReject);
          response.on("end", () => {
            if (settled) return;
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              settleReject();
              return;
            }
            settled = true;
            resolve(Buffer.concat(chunks).toString("utf8"));
          });
        }
      );
      request.setTimeout(this.timeoutMs, () => request.destroy());
      request.on("error", settleReject);
      request.end(body);
    });
  }
}

function parseHttpsUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("manufacturing enrollment URL is invalid");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new Error("manufacturing enrollment URL must use HTTPS");
  }
  return url;
}

async function readFactoryCa(path: string) {
  const ca = await readFile(path);
  if (
    ca.byteLength === 0 ||
    ca.byteLength > MAX_FACTORY_CA_BYTES ||
    !ca.toString("utf8").includes("-----BEGIN CERTIFICATE-----") ||
    ca.toString("utf8").includes("PRIVATE KEY")
  ) {
    throw new Error("factory CA is invalid");
  }
  return ca;
}

function validateRequest(input: ManufacturingEnrollmentRequest) {
  if (!SERIAL_PATTERN.test(input.serialNumber)) throw new Error("invalid request");
  if (typeof input.token !== "string" || input.token.length < 1 || Buffer.byteLength(input.token) > 2048) {
    throw new Error("invalid request");
  }
  if (
    typeof input.csrPem !== "string" ||
    Buffer.byteLength(input.csrPem) > 16 * 1024 ||
    !input.csrPem.includes("-----BEGIN CERTIFICATE REQUEST-----") ||
    input.csrPem.includes("PRIVATE KEY")
  ) {
    throw new Error("invalid request");
  }
}

function parseResponse(payload: string): ManufacturingEnrollmentResponse {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error("invalid response");
  }
  if (!value || typeof value !== "object") throw new Error("invalid response");
  const response = value as Record<string, unknown>;
  const deviceCertificatePem = certificate(response.deviceCertificatePem);
  const deviceCaBundlePem = certificate(response.deviceCaBundlePem);
  const apiCaBundlePem = certificate(response.apiCaBundlePem);
  const mqttCaBundlePem = certificate(response.mqttCaBundlePem);
  const claimCode = boundedText(response.claimCode, 2048);
  return { deviceCertificatePem, deviceCaBundlePem, apiCaBundlePem, mqttCaBundlePem, claimCode };
}

function certificate(value: unknown) {
  const pem = boundedText(value, MAX_FACTORY_CA_BYTES);
  if (!pem.includes("-----BEGIN CERTIFICATE-----") || pem.includes("PRIVATE KEY")) {
    throw new Error("invalid response");
  }
  return pem;
}

function boundedText(value: unknown, maxBytes: number) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw new Error("invalid response");
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error("invalid client option");
  return value;
}
