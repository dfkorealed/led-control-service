import { Test } from "@nestjs/testing";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import {
  CERTIFICATE_AUTHORITY_PROVIDER,
  UnavailableCertificateAuthorityProvider
} from "./certificate-authority.provider";
import { ManufacturingAuthGuard } from "./manufacturing-auth.guard";
import {
  MANUFACTURING_ENROLLMENT_CONFIGURATION,
  ManufacturingEnrollmentService
} from "./manufacturing-enrollment.service";
import { PkiModule } from "./pki.module";
import { VaultPkiProvider } from "./vault-pki.provider";

const environmentKeys = [
  "NODE_ENV",
  "PKI_PROVIDER",
  "VAULT_ADDR",
  "VAULT_TOKEN_FILE",
  "VAULT_NAMESPACE",
  "VAULT_CA_CERT_PATH",
  "VAULT_PKI_DEVICE_MOUNT",
  "VAULT_PKI_DEVICE_ROLE",
  "VAULT_PKI_MQTT_MOUNT",
  "VAULT_PKI_MQTT_ROLE",
  "VAULT_REQUEST_TIMEOUT_MS",
  "API_MANUFACTURING_CLIENT_CA_PATH",
  "API_DEVICE_CRL_PATH",
  "MQTT_CLIENT_CRL_PATH",
  "PKI_API_CA_BUNDLE_PATH",
  "PKI_MQTT_CA_BUNDLE_PATH"
] as const;

describe("PkiModule", () => {
  const originalEnvironment = new Map<string, string | undefined>();
  let temporaryDirectory: string;
  let tokenFile: string;
  let caFile: string;
  let manufacturingCaFile: string;
  let apiCaBundleFile: string;
  let mqttCaBundleFile: string;

  beforeAll(() => {
    for (const key of environmentKeys) originalEnvironment.set(key, process.env[key]);
  });

  beforeEach(async () => {
    for (const key of environmentKeys) delete process.env[key];
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pki-module-"));
    tokenFile = join(temporaryDirectory, "token");
    caFile = join(temporaryDirectory, "vault-ca.pem");
    manufacturingCaFile = join(temporaryDirectory, "manufacturing-ca.pem");
    apiCaBundleFile = join(temporaryDirectory, "api-ca-bundle.pem");
    mqttCaBundleFile = join(temporaryDirectory, "mqtt-ca-bundle.pem");
    await writeFile(tokenFile, "vault-token", { mode: 0o600 });
    await writeFile(caFile, rootCertificates[0]);
    await writeFile(manufacturingCaFile, rootCertificates[0]);
    await writeFile(apiCaBundleFile, rootCertificates[0]);
    await writeFile(mqttCaBundleFile, rootCertificates[0]);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const key of environmentKeys) {
      const original = originalEnvironment.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it("uses an unavailable provider by default outside production", async () => {
    process.env.NODE_ENV = "development";

    const module = await compilePkiModule();
    const provider = module.get(CERTIFICATE_AUTHORITY_PROVIDER);

    expect(provider).toBeInstanceOf(UnavailableCertificateAuthorityProvider);
    await expect(provider.signCsr(signInput())).rejects.toThrow("certificate authority is unavailable");
    await module.close();
  });

  it("requires the Vault provider in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.PKI_PROVIDER = "unavailable";

    await expect(compilePkiModule()).rejects.toThrow("PKI_PROVIDER=vault is required in production");
  });

  it.each([
    "VAULT_ADDR",
    "VAULT_TOKEN_FILE",
    "VAULT_CA_CERT_PATH",
    "VAULT_PKI_DEVICE_MOUNT",
    "VAULT_PKI_DEVICE_ROLE",
    "VAULT_PKI_MQTT_MOUNT",
    "VAULT_PKI_MQTT_ROLE"
  ] as const)("fails closed when production %s is missing", async (missingKey) => {
    setProductionVaultEnvironment();
    delete process.env[missingKey];

    await expect(compilePkiModule()).rejects.toThrow(`${missingKey} is required when PKI_PROVIDER=vault`);
  });

  it("requires HTTPS and readable CA/token files in production", async () => {
    setProductionVaultEnvironment();
    process.env.VAULT_ADDR = "http://vault.internal:8200";
    await expect(compilePkiModule()).rejects.toThrow("VAULT_ADDR must use HTTPS in production");

    process.env.VAULT_ADDR = "https://vault.internal:8200";
    process.env.VAULT_CA_CERT_PATH = join(temporaryDirectory, "missing-ca.pem");
    await expect(compilePkiModule()).rejects.toThrow("VAULT_CA_CERT_PATH is not readable");

    process.env.VAULT_CA_CERT_PATH = caFile;
    process.env.VAULT_TOKEN_FILE = join(temporaryDirectory, "missing-token");
    await expect(compilePkiModule()).rejects.toThrow("VAULT_TOKEN_FILE is not readable");
  });

  it("creates the Vault provider from complete production configuration", async () => {
    setProductionVaultEnvironment();
    process.env.VAULT_NAMESPACE = "production/gateways";
    process.env.VAULT_REQUEST_TIMEOUT_MS = "2500";

    const module = await compilePkiModule();

    expect(module.get(CERTIFICATE_AUTHORITY_PROVIDER)).toBeInstanceOf(VaultPkiProvider);
    expect(module.get(ManufacturingAuthGuard)).toBeInstanceOf(ManufacturingAuthGuard);
    expect(module.get(ManufacturingEnrollmentService)).toBeInstanceOf(ManufacturingEnrollmentService);
    expect(module.get(MANUFACTURING_ENROLLMENT_CONFIGURATION)).toMatchObject({
      apiCaBundlePem: rootCertificates[0],
      mqttCaBundlePem: rootCertificates[0],
      manufacturingCaFingerprint: expect.stringMatching(/^[0-9A-F]{64}$/)
    });
    await module.close();
  });

  it.each([
    "API_MANUFACTURING_CLIENT_CA_PATH",
    "API_DEVICE_CRL_PATH",
    "MQTT_CLIENT_CRL_PATH",
    "PKI_API_CA_BUNDLE_PATH",
    "PKI_MQTT_CA_BUNDLE_PATH"
  ] as const)("fails closed when production %s is missing", async (missingKey) => {
    setProductionVaultEnvironment();
    delete process.env[missingKey];

    await expect(compilePkiModule()).rejects.toThrow(`${missingKey} is required in production`);
  });

  function setProductionVaultEnvironment() {
    Object.assign(process.env, {
      NODE_ENV: "production",
      PKI_PROVIDER: "vault",
      VAULT_ADDR: "https://vault.internal:8200",
      VAULT_TOKEN_FILE: tokenFile,
      VAULT_CA_CERT_PATH: caFile,
      VAULT_PKI_DEVICE_MOUNT: "device-pki",
      VAULT_PKI_DEVICE_ROLE: "gateway-device",
      VAULT_PKI_MQTT_MOUNT: "mqtt-pki",
      VAULT_PKI_MQTT_ROLE: "gateway-mqtt",
      API_MANUFACTURING_CLIENT_CA_PATH: manufacturingCaFile,
      API_DEVICE_CRL_PATH: join(temporaryDirectory, "device.crl"),
      MQTT_CLIENT_CRL_PATH: join(temporaryDirectory, "mqtt.crl"),
      PKI_API_CA_BUNDLE_PATH: apiCaBundleFile,
      PKI_MQTT_CA_BUNDLE_PATH: mqttCaBundleFile
    });
  }
});

function compilePkiModule() {
  return Test.createTestingModule({ imports: [PkiModule] }).compile();
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
