import { isIP } from "node:net";

type TrustProxyApp = {
  set(setting: string, value: number | string[]): unknown;
};

type TrustProxyEnv = {
  API_TRUST_PROXY?: string;
};

const MAX_PROXY_HOPS = 255;

export function configureApiTrustProxy(
  app: TrustProxyApp,
  env: TrustProxyEnv = process.env
) {
  const raw = env.API_TRUST_PROXY?.trim();
  if (!raw) return;

  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (Number.isSafeInteger(hops) && hops <= MAX_PROXY_HOPS) {
      app.set("trust proxy", hops);
      return;
    }
    throw invalidConfiguration(raw);
  }

  const addresses = raw.split(",").map((value) => value.trim());
  if (addresses.length === 0 || addresses.some((value) => !isAddressOrCidr(value))) {
    throw invalidConfiguration(raw);
  }
  app.set("trust proxy", addresses);
}

function isAddressOrCidr(value: string) {
  if (isIP(value) !== 0) return true;

  const separator = value.lastIndexOf("/");
  if (separator <= 0 || separator === value.length - 1) return false;
  const address = value.slice(0, separator);
  const prefix = value.slice(separator + 1);
  const version = isIP(address);
  if (version === 0 || !/^\d+$/.test(prefix)) return false;

  const prefixLength = Number(prefix);
  return prefixLength >= 0 && prefixLength <= (version === 4 ? 32 : 128);
}

function invalidConfiguration(value: string) {
  return new Error(`Invalid API_TRUST_PROXY: ${value}`);
}
