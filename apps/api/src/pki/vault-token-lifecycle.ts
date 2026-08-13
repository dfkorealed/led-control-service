import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";

interface Lease {
  renewable: boolean;
  ttlSeconds: number;
  policies: string[];
}

export interface VaultTokenLifecycleOptions {
  address: string;
  tokenFile: string;
  expectedPolicy: string;
  namespace?: string;
  caPem?: string;
  requestTimeoutMs: number;
  onFatal: () => void | Promise<void>;
  logger?: Pick<Console, "error">;
  schedule?: (listener: () => void | Promise<void>, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

export async function startVaultTokenLifecycle(options: VaultTokenLifecycleOptions) {
  const baseUrl = validateOptions(options);
  const logger = options.logger ?? console;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failing = false;

  const initialLease = await requestLease("lookup", options, baseUrl);
  validateLease(initialLease, options.expectedPolicy);
  scheduleRenewal(initialLease.ttlSeconds);

  function scheduleRenewal(ttlSeconds: number) {
    if (stopped) return;
    timer = schedule(() => renewOrFail().catch(() => undefined), Math.max(1_000, Math.floor(ttlSeconds * 500)));
  }

  async function renewOrFail() {
    if (stopped || failing) return;
    if (timer) { cancel(timer); timer = undefined; }
    try {
      const lease = await requestLease("renew", options, baseUrl);
      validateLease(lease, options.expectedPolicy);
      scheduleRenewal(lease.ttlSeconds);
    } catch (error) {
      failing = true;
      stopped = true;
      logger.error("[vault-token] renewal failed; closing API to fail closed.");
      await options.onFatal();
      throw error;
    }
  }

  return {
    renewNow: renewOrFail,
    stop() {
      stopped = true;
      if (timer) { cancel(timer); timer = undefined; }
    }
  };
}

function validateOptions(options: VaultTokenLifecycleOptions) {
  const url = new URL(options.address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error("VAULT_ADDR must contain only an HTTP(S) scheme, host, and port");
  }
  if (!options.tokenFile || !options.expectedPolicy || options.requestTimeoutMs < 1) throw new Error("Vault token lifecycle configuration is incomplete");
  return url;
}

async function requestLease(kind: "lookup" | "renew", options: VaultTokenLifecycleOptions, baseUrl: URL): Promise<Lease> {
  const token = (await readFile(options.tokenFile, "utf8")).trim();
  if (!token || /[\r\n]/.test(token)) throw new Error("Vault token file is invalid");
  const path = kind === "lookup" ? "/v1/auth/token/lookup-self" : "/v1/auth/token/renew-self";
  const url = new URL(path, baseUrl);
  const payload = kind === "renew" ? Buffer.from("{}") : undefined;
  const response = await new Promise<unknown>((resolve, reject) => {
    const requestOptions: RequestOptions = {
      method: kind === "lookup" ? "GET" : "POST",
      headers: {
        accept: "application/json",
        "x-vault-token": token,
        ...(payload ? { "content-type": "application/json", "content-length": payload.byteLength } : {}),
        ...(options.namespace ? { "x-vault-namespace": options.namespace } : {})
      },
      ...(url.protocol === "https:" ? { ca: options.caPem, rejectUnauthorized: true } : {})
    };
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(url, requestOptions, response => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > 64 * 1024) response.destroy(new Error("Vault token response exceeded the size limit"));
        else chunks.push(Buffer.from(chunk));
      });
      response.on("error", () => reject(new Error("Vault token request failed")));
      response.on("end", () => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) { reject(new Error(`Vault token request failed with status ${response.statusCode ?? 0}`)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("Vault token response is invalid")); }
      });
    });
    request.setTimeout(options.requestTimeoutMs, () => request.destroy(new Error("Vault token request timed out")));
    request.on("error", error => reject(new Error(error.message === "Vault token request timed out" ? error.message : "Vault token request failed")));
    request.end(payload);
  });
  if (!isRecord(response)) throw new Error("Vault token response is invalid");
  const source = kind === "lookup" ? response.data : response.auth;
  if (!isRecord(source)) throw new Error("Vault token response is invalid");
  const ttl = kind === "lookup" ? source.ttl : source.lease_duration;
  return { renewable: source.renewable === true, ttlSeconds: Number(ttl), policies: Array.isArray(source.policies) ? source.policies.filter((item): item is string => typeof item === "string") : [] };
}

function validateLease(lease: Lease, expectedPolicy: string) {
  if (!lease.renewable || !Number.isInteger(lease.ttlSeconds) || lease.ttlSeconds < 60 || lease.policies.length !== 1 || lease.policies[0] !== expectedPolicy) {
    throw new Error("Vault application token must be renewable, unexpired, and limited to gateway-pki");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
