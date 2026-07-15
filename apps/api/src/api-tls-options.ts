import { readFileSync } from "node:fs";

const TLS_PATH_KEYS = [
  "API_TLS_CERT_PATH",
  "API_TLS_KEY_PATH",
  "API_DEVICE_CLIENT_CA_PATH",
  "API_MANUFACTURING_CLIENT_CA_PATH"
] as const;

type TlsPathKey = (typeof TLS_PATH_KEYS)[number];
type ReadFile = (path: string) => Buffer;

export function createApiHttpsOptions(env: NodeJS.ProcessEnv, readFile: ReadFile = (path) => readFileSync(path)) {
  const values = Object.fromEntries(TLS_PATH_KEYS.map((key) => [key, env[key]?.trim()])) as Record<TlsPathKey, string | undefined>;
  const configuredCount = TLS_PATH_KEYS.filter((key) => values[key]).length;

  if (env.NODE_ENV === "production") {
    for (const key of TLS_PATH_KEYS) {
      if (!values[key]) throw new Error(`${key} is required in production`);
    }
  } else if (configuredCount === 0) {
    return {};
  } else if (configuredCount !== TLS_PATH_KEYS.length) {
    throw new Error("API TLS configuration must set all certificate paths");
  }

  const cert = readRequired(values.API_TLS_CERT_PATH, "API_TLS_CERT_PATH", readFile);
  const key = readRequired(values.API_TLS_KEY_PATH, "API_TLS_KEY_PATH", readFile);
  const deviceCa = readRequired(values.API_DEVICE_CLIENT_CA_PATH, "API_DEVICE_CLIENT_CA_PATH", readFile);
  const manufacturingCa = readRequired(values.API_MANUFACTURING_CLIENT_CA_PATH, "API_MANUFACTURING_CLIENT_CA_PATH", readFile);

  return {
    httpsOptions: {
      cert,
      key,
      ca: [deviceCa, manufacturingCa],
      requestCert: true,
      rejectUnauthorized: false
    }
  };
}

function readRequired(path: string | undefined, key: TlsPathKey, readFile: ReadFile) {
  if (!path) throw new Error(`${key} is required`);
  try {
    return readFile(path);
  } catch {
    throw new Error(`${key} is not readable`);
  }
}
