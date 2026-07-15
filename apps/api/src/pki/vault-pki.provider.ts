import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import type { CertificatePurpose, RevokeCertificateInput, SignCsrInput, SignedCertificate } from "./pki.types";
import type { CertificateAuthorityProvider } from "./certificate-authority.provider";

interface VaultRolePath {
  mount: string;
  role: string;
}

export interface VaultPkiProviderOptions {
  address: string;
  tokenFile: string;
  namespace?: string;
  caPem?: string;
  requestTimeoutMs: number;
  requireHttps: boolean;
  device: VaultRolePath;
  mqtt: VaultRolePath;
}

interface VaultResponse {
  data: Record<string, unknown>;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const VAULT_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class VaultPkiProvider implements CertificateAuthorityProvider {
  private readonly baseUrl: URL;
  private readonly rolePaths: Record<CertificatePurpose, VaultRolePath>;

  constructor(private readonly options: VaultPkiProviderOptions) {
    this.baseUrl = parseVaultAddress(options.address, options.requireHttps);
    validateOptions(options);
    this.rolePaths = {
      device: { ...options.device },
      mqtt: { ...options.mqtt }
    };
  }

  async signCsr(input: SignCsrInput): Promise<SignedCertificate> {
    validateSignInput(input);
    const rolePath = this.rolePaths[input.purpose];
    const response = await this.requestJson(
      `/v1/${encodeURIComponent(rolePath.mount)}/sign/${encodeURIComponent(rolePath.role)}`,
      {
        csr: input.csrPem,
        common_name: input.commonName,
        uri_sans: input.uriSans,
        ttl: `${input.ttlSeconds}s`,
        format: "pem"
      }
    );

    return signedCertificateFrom(response.data);
  }

  async revoke(input: RevokeCertificateInput): Promise<void> {
    if (!input.issuer.trim() || !input.fingerprint.trim()) {
      throw new Error("issuer and fingerprint are required to identify a certificate");
    }
    const serialNumber = normalizeVaultSerial(input.certificateSerial);
    const rolePath = this.rolePaths[input.purpose];
    await this.requestJson(`/v1/${encodeURIComponent(rolePath.mount)}/revoke`, {
      serial_number: serialNumber
    });
  }

  async readCrl(purpose: CertificatePurpose): Promise<string> {
    const rolePath = this.rolePaths[purpose];
    const token = await readVaultToken(this.options.tokenFile);
    const url = new URL(`/v1/${encodeURIComponent(rolePath.mount)}/crl/pem`, this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      return await new Promise<string>((resolve, reject) => {
        const requestOptions: HttpsRequestOptions = {
          method: "GET",
          signal: controller.signal,
          headers: {
            accept: "application/x-pem-file",
            "x-vault-token": token,
            ...(this.options.namespace ? { "x-vault-namespace": this.options.namespace } : {})
          },
          ...(url.protocol === "https:" ? { ca: this.options.caPem, rejectUnauthorized: true } : {})
        };
        const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
        const request = transport(url, requestOptions, (response) => {
          const chunks: Buffer[] = [];
          let responseBytes = 0;
          response.on("data", (chunk: Buffer) => {
            responseBytes += chunk.byteLength;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              response.destroy(new Error("Vault PKI response exceeded the size limit"));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.on("error", () => reject(new Error("Vault PKI request failed")));
          response.on("end", () => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`Vault PKI request failed with status ${statusCode}`));
              return;
            }
            const pem = Buffer.concat(chunks).toString("utf8");
            if (!isPemCrl(pem)) {
              reject(new Error("Vault PKI returned an invalid CRL"));
              return;
            }
            resolve(pem);
          });
        });
        request.on("error", (error: NodeJS.ErrnoException) => {
          if (controller.signal.aborted || error.name === "AbortError" || error.code === "ABORT_ERR") {
            reject(new Error("Vault PKI request timed out"));
            return;
          }
          reject(new Error("Vault PKI request failed"));
        });
        request.end();
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestJson(path: string, body: Record<string, unknown>): Promise<VaultResponse> {
    const token = await readVaultToken(this.options.tokenFile);
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const url = new URL(path, this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);

    try {
      return await new Promise<VaultResponse>((resolve, reject) => {
        const requestOptions: HttpsRequestOptions = {
          method: "POST",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "content-length": payload.byteLength,
            "x-vault-token": token,
            ...(this.options.namespace ? { "x-vault-namespace": this.options.namespace } : {})
          },
          ...(url.protocol === "https:"
            ? { ca: this.options.caPem, rejectUnauthorized: true }
            : {})
        };
        const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
        const request = transport(url, requestOptions, (response) => {
          const chunks: Buffer[] = [];
          let responseBytes = 0;

          response.on("data", (chunk: Buffer) => {
            responseBytes += chunk.byteLength;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              response.destroy(new Error("Vault PKI response exceeded the size limit"));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.on("error", () => reject(new Error("Vault PKI request failed")));
          response.on("end", () => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`Vault PKI request failed with status ${statusCode}`));
              return;
            }
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
              if (!isRecord(parsed) || !isRecord(parsed.data)) throw new Error("invalid response");
              resolve({ data: parsed.data });
            } catch {
              reject(new Error("Vault PKI returned an invalid response"));
            }
          });
        });

        request.on("error", (error: NodeJS.ErrnoException) => {
          if (controller.signal.aborted || error.name === "AbortError" || error.code === "ABORT_ERR") {
            reject(new Error("Vault PKI request timed out"));
            return;
          }
          reject(new Error("Vault PKI request failed"));
        });
        request.end(payload);
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseVaultAddress(address: string, requireHttps: boolean): URL {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("VAULT_ADDR must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("VAULT_ADDR must use HTTP or HTTPS");
  }
  if (requireHttps && url.protocol !== "https:") {
    throw new Error("VAULT_ADDR must use HTTPS in production");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("VAULT_ADDR must contain only scheme, host, and port");
  }
  return url;
}

function validateOptions(options: VaultPkiProviderOptions) {
  if (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) {
    throw new Error("Vault request timeout must be a positive integer");
  }
  if (options.namespace && /[\r\n]/.test(options.namespace)) {
    throw new Error("VAULT_NAMESPACE contains invalid characters");
  }
  for (const purpose of ["device", "mqtt"] as const) {
    for (const key of ["mount", "role"] as const) {
      const value = options[purpose][key];
      if (!VAULT_PATH_SEGMENT.test(value) || value === "." || value === "..") {
        throw new Error(`${purpose} ${key} must be a single Vault path segment`);
      }
    }
  }
}

function validateSignInput(input: SignCsrInput) {
  if (!input.csrPem.trim()) throw new Error("CSR is required");
  if (!input.commonName.trim()) throw new Error("common name is required");
  if (!Array.isArray(input.uriSans) || input.uriSans.some((uri) => !uri.trim())) {
    throw new Error("URI SANs must be non-empty strings");
  }
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1) {
    throw new Error("certificate TTL must be a positive integer");
  }
}

async function readVaultToken(tokenFile: string): Promise<string> {
  let token: string;
  try {
    token = (await readFile(tokenFile, "utf8")).trim();
  } catch {
    throw new Error("Vault token file is not readable");
  }
  if (!token) throw new Error("Vault token file is empty");
  return token;
}

function signedCertificateFrom(data: Record<string, unknown>): SignedCertificate {
  const certificatePem = requiredString(data.certificate);
  const caChainPem = requiredStringArray(data.ca_chain);
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    throw new Error("Vault PKI returned an invalid certificate");
  }

  return {
    certificatePem,
    caChainPem,
    certificateSerial: optionalString(data.serial_number) ?? certificate.serialNumber,
    fingerprint: optionalString(data.fingerprint) ?? certificate.fingerprint256,
    issuer: optionalString(data.issuer) ?? certificate.issuer,
    notBefore: optionalDate(data.not_before) ?? new Date(certificate.validFrom).toISOString(),
    notAfter:
      optionalDate(data.not_after) ?? optionalDate(data.expiration) ?? new Date(certificate.validTo).toISOString()
  };
}

function requiredString(value: unknown): string {
  const result = optionalString(value);
  if (!result) throw new Error("Vault PKI returned an invalid response");
  return result;
}

function requiredStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("Vault PKI returned an invalid response");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const date =
    typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))
      ? new Date(Number(value) * 1000)
      : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("Vault PKI returned invalid certificate metadata");
  return date.toISOString();
}

function normalizeVaultSerial(value: string): string {
  const compact = value.replace(/[:-]/g, "");
  if (!compact || compact.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(compact)) {
    throw new Error("certificate serial must be colon- or hyphen-separated hexadecimal");
  }
  return compact.match(/.{2}/g)?.join(":") ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPemCrl(value: string) {
  return /^-----BEGIN X509 CRL-----\r?\n[\s\S]+-----END X509 CRL-----\r?\n?$/.test(value);
}
