import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiHttpsOptions } from "./api-tls-options";

describe("createApiHttpsOptions", () => {
  it("trusts both client CAs and expands every CRL PEM block for Node TLS", () => {
    const material = createTlsMaterial();
    try {
      const result = createApiHttpsOptions(completeEnvironment(), (path: string) => material.files[path]);

      expect(result).toEqual({
        httpsOptions: {
          cert: material.files["/tls/api.crt"],
          key: material.files["/tls/api.key"],
          ca: [material.files["/tls/device-ca.crt"], material.files["/tls/manufacturing-ca.crt"]],
          crl: [material.files["/tls/device.crl"], material.files["/tls/manufacturing.crl"]],
          requestCert: true,
          rejectUnauthorized: true
        }
      });
    } finally {
      material.cleanup();
    }
  });

  it.each([
    (crl: string) => `unexpected content before CRL\n${crl}`,
    (crl: string) => `${crl}\nunexpected content after CRL`,
    (crl: string) => `${crl}\n-----BEGIN X509 CRL-----\ntruncated`
  ])("rejects non-whitespace content in an explicit CRL bundle", (createMalformedCrl) => {
    const material = createTlsMaterial();
    try {
      const files: Record<string, Buffer> = { ...material.files, "/tls/device.crl": Buffer.from(createMalformedCrl(material.crl)) };

      expect(() => createApiHttpsOptions(completeEnvironment(), (path: string) => files[path])).toThrow(
        "API_DEVICE_CRL_PATH contains invalid CRL PEM bundle"
      );
    } finally {
      material.cleanup();
    }
  });

  it.each([
    ["API_TLS_CERT_PATH", "/tls/api.crt", Buffer.from("not a certificate")],
    ["API_TLS_KEY_PATH", "/tls/api.key", Buffer.from("not a private key")],
    ["API_DEVICE_CLIENT_CA_PATH", "/tls/device-ca.crt", Buffer.from("not a CA certificate")],
    ["API_DEVICE_CRL_PATH", "/tls/device.crl", Buffer.from(pemCrl("not a CRL"))]
  ])("fails closed when explicit %s material is invalid", (_key, path, invalidMaterial) => {
    const material = createTlsMaterial();
    try {
      const files: Record<string, Buffer> = { ...material.files, [path]: invalidMaterial };

      expect(() => createApiHttpsOptions(completeEnvironment(), (candidate: string) => files[candidate])).toThrow(
        "API TLS material is invalid"
      );
    } finally {
      material.cleanup();
    }
  });

  it("allows HTTP only when no TLS setting is present outside production", () => {
    expect(createApiHttpsOptions({ NODE_ENV: "test" }, jest.fn())).toEqual({});
  });

  it("rejects partial TLS configuration outside production", () => {
    expect(() =>
      createApiHttpsOptions({ NODE_ENV: "development", API_TLS_CERT_PATH: "/tls/api.crt" }, jest.fn())
    ).toThrow("API TLS configuration must set all certificate paths");
  });

  it.each([
    "API_TLS_CERT_PATH",
    "API_TLS_KEY_PATH",
    "API_DEVICE_CLIENT_CA_PATH",
    "API_MANUFACTURING_CLIENT_CA_PATH",
    "API_DEVICE_CRL_PATH",
    "API_MANUFACTURING_CRL_PATH"
  ] as const)("fails closed when production %s is missing", (missingKey) => {
    const env = completeEnvironment();
    delete env[missingKey];

    expect(() => createApiHttpsOptions(env, jest.fn())).toThrow(`${missingKey} is required in production`);
  });
});

function pemCrl(body: string) {
  return `-----BEGIN X509 CRL-----\n${body}\n-----END X509 CRL-----\n`;
}

function createTlsMaterial() {
  const directory = mkdtempSync(join(tmpdir(), "api-tls-options-"));
  const caKey = join(directory, "ca.key");
  const caCertificate = join(directory, "ca.crt");
  const crl = join(directory, "ca.crl");
  try {
    writeFileSync(join(directory, "index.txt"), "");
    writeFileSync(join(directory, "serial"), "1000\n");
    writeFileSync(join(directory, "crlnumber"), "1000\n");
    execFileSync("openssl", ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", caKey]);
    execFileSync("openssl", ["req", "-x509", "-new", "-key", caKey, "-out", caCertificate, "-days", "1", "-subj", "/CN=api-tls-test-ca", "-addext", "basicConstraints=critical,CA:true", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    writeFileSync(join(directory, "openssl.cnf"), [
      "[ ca ]", "default_ca = test_ca", "[ test_ca ]", `database = ${join(directory, "index.txt")}`,
      `new_certs_dir = ${directory}`, `certificate = ${caCertificate}`, `private_key = ${caKey}`,
      `serial = ${join(directory, "serial")}`, `crlnumber = ${join(directory, "crlnumber")}`,
      "default_md = sha256", "default_crl_days = 1", ""
    ].join("\n"));
    execFileSync("openssl", ["ca", "-config", join(directory, "openssl.cnf"), "-gencrl", "-out", crl], { stdio: "ignore" });
    const certificate = readFileSync(caCertificate);
    const key = readFileSync(caKey);
    const crlBuffer = readFileSync(crl);
    return {
      crl: crlBuffer.toString("utf8"),
      files: {
        "/tls/api.crt": certificate,
        "/tls/api.key": key,
        "/tls/device-ca.crt": certificate,
        "/tls/manufacturing-ca.crt": certificate,
        "/tls/device.crl": crlBuffer,
        "/tls/manufacturing.crl": crlBuffer
      } as Record<string, Buffer>,
      cleanup: () => rmSync(directory, { recursive: true, force: true })
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function completeEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    API_TLS_CERT_PATH: "/tls/api.crt",
    API_TLS_KEY_PATH: "/tls/api.key",
    API_DEVICE_CLIENT_CA_PATH: "/tls/device-ca.crt",
    API_MANUFACTURING_CLIENT_CA_PATH: "/tls/manufacturing-ca.crt",
    API_DEVICE_CRL_PATH: "/tls/device.crl",
    API_MANUFACTURING_CRL_PATH: "/tls/manufacturing.crl"
  };
}
