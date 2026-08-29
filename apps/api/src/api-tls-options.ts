import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSecureContext } from "node:tls";

const TLS_PATH_KEYS = [
  "API_TLS_CERT_PATH",
  "API_TLS_KEY_PATH",
  "API_DEVICE_CLIENT_CA_PATH",
  "API_MANUFACTURING_CLIENT_CA_PATH",
  "API_DEVICE_CRL_PATH",
  "API_MANUFACTURING_CRL_PATH"
] as const;
const CRL_PEM_PATTERN = /-----BEGIN X509 CRL-----[\s\S]*?-----END X509 CRL-----/g;
const CERTIFICATE_PEM_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

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
  const deviceCrl = readCrlBundle(values.API_DEVICE_CRL_PATH, "API_DEVICE_CRL_PATH", readFile);
  const manufacturingCrl = readCrlBundle(values.API_MANUFACTURING_CRL_PATH, "API_MANUFACTURING_CRL_PATH", readFile);

  const httpsOptions = {
    cert,
    key,
    ca: [deviceCa, manufacturingCa],
    crl: [...deviceCrl, ...manufacturingCrl],
    requestCert: true,
    rejectUnauthorized: true
  };
  validateTlsMaterial(httpsOptions);

  return { httpsOptions };
}

function readCrlBundle(path: string | undefined, key: TlsPathKey, readFile: ReadFile) {
  const source = readRequired(path, key, readFile).toString("utf8");
  const blocks = [...source.matchAll(CRL_PEM_PATTERN)];
  if (!blocks.length) throw new Error(`${key} does not contain a CRL PEM block`);

  let offset = 0;
  for (const block of blocks) {
    const start = block.index ?? 0;
    if (source.slice(offset, start).trim()) throw new Error(`${key} contains invalid CRL PEM bundle`);
    offset = start + block[0].length;
  }
  if (source.slice(offset).trim()) throw new Error(`${key} contains invalid CRL PEM bundle`);

  return blocks.map((block) => Buffer.from(`${block[0]}\n`));
}

function validateTlsMaterial(options: { cert: Buffer; key: Buffer; ca: Buffer[]; crl: Buffer[]; requestCert: boolean; rejectUnauthorized: boolean }) {
  try {
    validateCertificateBundle(options.cert);
    options.ca?.forEach(validateCertificateBundle);
    createSecureContext(options);
  } catch {
    throw new Error("API TLS material is invalid");
  }
}

function validateCertificateBundle(material: string | Buffer) {
  const source = material.toString();
  const blocks = [...source.matchAll(CERTIFICATE_PEM_PATTERN)];
  if (!blocks.length) throw new Error("certificate PEM block is required");

  let offset = 0;
  for (const block of blocks) {
    const start = block.index ?? 0;
    if (source.slice(offset, start).trim()) throw new Error("certificate PEM bundle is invalid");
    new X509Certificate(block[0]);
    offset = start + block[0].length;
  }
  if (source.slice(offset).trim()) throw new Error("certificate PEM bundle is invalid");
}

function readRequired(path: string | undefined, key: TlsPathKey, readFile: ReadFile) {
  if (!path) throw new Error(`${key} is required`);
  try {
    return readFile(path);
  } catch {
    throw new Error(`${key} is not readable`);
  }
}
