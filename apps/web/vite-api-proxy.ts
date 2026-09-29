import { readFileSync } from "node:fs";
import { Agent } from "node:https";
import { isIP } from "node:net";
import type { ProxyOptions } from "vite";

type ReadFile = (path: string) => Buffer;

export function createViteApiProxyOptions(
  env: NodeJS.ProcessEnv,
  readFile: ReadFile = readFileSync
): ProxyOptions {
  const target = env.VITE_API_PROXY_TARGET ?? "http://localhost:4000";
  const localAppOnly = env.DEV_LOCAL_APP_ONLY === "1";
  if (localAppOnly) requireLoopbackApiTarget(target, env.API_PORT ?? "4000");
  return {
    target,
    changeOrigin: true,
    secure: true,
    ...(localAppOnly ? {
      agent: new Agent({
        ca: readFile(requiredValue(env.PKI_API_CA_BUNDLE_PATH, "PKI_API_CA_BUNDLE_PATH")),
        servername: requiredDnsName(env.LAB_API_DNS, "LAB_API_DNS"),
        rejectUnauthorized: true
      })
    } : {}),
    rewrite: (path) => path.replace(/^\/api/, "")
  };
}

function requireLoopbackApiTarget(target: string, apiPort: string) {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error("VITE_API_PROXY_TARGET must be a valid local-app loopback URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== apiPort ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`VITE_API_PROXY_TARGET must equal https://127.0.0.1:${apiPort} in local-app mode.`);
  }
}

function requiredValue(value: string | undefined, name: string) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required in local-app mode.`);
  return normalized;
}

function requiredDnsName(value: string | undefined, name: string) {
  const hostname = requiredValue(value, name);
  const label = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
  if (isIP(hostname) !== 0 || hostname.length > 253 || !new RegExp(`^(?:${label}\\.)+${label}$`).test(hostname)) {
    throw new Error(`${name} must be a valid DNS hostname in local-app mode.`);
  }
  return hostname;
}
