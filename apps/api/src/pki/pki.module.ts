import { Module } from "@nestjs/common";
import { X509Certificate } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { PrismaModule } from "../prisma/prisma.module";
import {
  CERTIFICATE_AUTHORITY_PROVIDER,
  UnavailableCertificateAuthorityProvider,
  type CertificateAuthorityProvider
} from "./certificate-authority.provider";
import { GatewayCsrValidator } from "./csr-validator";
import { MANUFACTURING_CA_FINGERPRINT, ManufacturingAuthGuard } from "./manufacturing-auth.guard";
import { ManufacturingEnrollmentController } from "./manufacturing-enrollment.controller";
import {
  MANUFACTURING_ENROLLMENT_CONFIGURATION,
  ManufacturingEnrollmentService,
  type ManufacturingEnrollmentConfiguration
} from "./manufacturing-enrollment.service";
import { VaultPkiProvider, type VaultPkiProviderOptions } from "./vault-pki.provider";

@Module({
  imports: [PrismaModule],
  controllers: [ManufacturingEnrollmentController],
  providers: [
    {
      provide: CERTIFICATE_AUTHORITY_PROVIDER,
      useFactory: () => createCertificateAuthorityProvider(process.env)
    },
    {
      provide: MANUFACTURING_ENROLLMENT_CONFIGURATION,
      useFactory: () => createManufacturingEnrollmentConfiguration(process.env)
    },
    GatewayCsrValidator,
    ManufacturingEnrollmentService,
    {
      provide: MANUFACTURING_CA_FINGERPRINT,
      inject: [MANUFACTURING_ENROLLMENT_CONFIGURATION],
      useFactory: (configuration: ManufacturingEnrollmentConfiguration) =>
        configuration.manufacturingCaFingerprint
    },
    ManufacturingAuthGuard
  ],
  exports: [CERTIFICATE_AUTHORITY_PROVIDER]
})
export class PkiModule {}

export function createManufacturingEnrollmentConfiguration(env: NodeJS.ProcessEnv): ManufacturingEnrollmentConfiguration {
  const manufacturingCaPath = productionPath(env, "API_MANUFACTURING_CLIENT_CA_PATH");
  const apiCaBundlePath = productionPath(env, "PKI_API_CA_BUNDLE_PATH");
  const mqttCaBundlePath = productionPath(env, "PKI_MQTT_CA_BUNDLE_PATH");

  const manufacturingBundle = manufacturingCaPath
    ? readCertificateBundle(manufacturingCaPath, "API_MANUFACTURING_CLIENT_CA_PATH")
    : null;
  if (manufacturingBundle && manufacturingBundle.certificates.length !== 1) {
    throw new Error("API_MANUFACTURING_CLIENT_CA_PATH must contain exactly one issuing CA certificate");
  }
  const apiBundle = apiCaBundlePath ? readCertificateBundle(apiCaBundlePath, "PKI_API_CA_BUNDLE_PATH") : null;
  const mqttBundle = mqttCaBundlePath ? readCertificateBundle(mqttCaBundlePath, "PKI_MQTT_CA_BUNDLE_PATH") : null;

  return {
    manufacturingCaFingerprint: manufacturingBundle
      ? normalizeFingerprint(manufacturingBundle.certificates[0].fingerprint256)
      : null,
    apiCaBundlePem: apiBundle?.pem ?? null,
    mqttCaBundlePem: mqttBundle?.pem ?? null
  };
}

export function createCertificateAuthorityProvider(env: NodeJS.ProcessEnv): CertificateAuthorityProvider {
  const production = env.NODE_ENV === "production";
  const providerName = env.PKI_PROVIDER?.trim();

  if (production && providerName !== "vault") {
    throw new Error("PKI_PROVIDER=vault is required in production");
  }
  if (!providerName || providerName === "unavailable") {
    return new UnavailableCertificateAuthorityProvider();
  }
  if (providerName !== "vault") {
    throw new Error("PKI_PROVIDER must be vault or unavailable");
  }

  const address = requiredEnvironment(env, "VAULT_ADDR");
  const tokenFile = requiredEnvironment(env, "VAULT_TOKEN_FILE");
  const deviceMount = requiredEnvironment(env, "VAULT_PKI_DEVICE_MOUNT");
  const deviceRole = requiredEnvironment(env, "VAULT_PKI_DEVICE_ROLE");
  const mqttMount = requiredEnvironment(env, "VAULT_PKI_MQTT_MOUNT");
  const mqttRole = requiredEnvironment(env, "VAULT_PKI_MQTT_ROLE");
  const caPath = production ? requiredEnvironment(env, "VAULT_CA_CERT_PATH") : env.VAULT_CA_CERT_PATH?.trim();

  assertReadable(tokenFile, "VAULT_TOKEN_FILE");
  const caPem = caPath ? readCaCertificate(caPath) : undefined;
  const options: VaultPkiProviderOptions = {
    address,
    tokenFile,
    namespace: env.VAULT_NAMESPACE?.trim() || undefined,
    caPem,
    requestTimeoutMs: parseRequestTimeout(env.VAULT_REQUEST_TIMEOUT_MS),
    requireHttps: production,
    device: { mount: deviceMount, role: deviceRole },
    mqtt: { mount: mqttMount, role: mqttRole }
  };
  return new VaultPkiProvider(options);
}

function requiredEnvironment(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required when PKI_PROVIDER=vault`);
  return value;
}

function assertReadable(path: string, key: string) {
  try {
    accessSync(path, constants.R_OK);
  } catch {
    throw new Error(`${key} is not readable`);
  }
}

function readCaCertificate(path: string): string {
  assertReadable(path, "VAULT_CA_CERT_PATH");
  let caPem: string;
  try {
    caPem = readFileSync(path, "utf8");
    new X509Certificate(caPem);
  } catch {
    throw new Error("VAULT_CA_CERT_PATH does not contain a valid certificate");
  }
  return caPem;
}

function productionPath(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  if (env.NODE_ENV === "production" && !value) throw new Error(`${key} is required in production`);
  return value || undefined;
}

function readCertificateBundle(path: string, key: string) {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${key} is not readable`);
  }
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) throw new Error(`${key} does not contain a valid certificate`);
  try {
    return { pem, certificates: blocks.map((block) => new X509Certificate(block)) };
  } catch {
    throw new Error(`${key} does not contain a valid certificate`);
  }
}

function normalizeFingerprint(value: string) {
  return value.replace(/:/g, "").toUpperCase();
}

function parseRequestTimeout(value: string | undefined): number {
  if (!value?.trim()) return 5_000;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new Error("VAULT_REQUEST_TIMEOUT_MS must be an integer between 1 and 120000");
  }
  return timeout;
}
