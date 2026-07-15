import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { OpenSslCsrGenerator } from "./openssl-csr-generator";
import type { MqttCertificateResponse } from "./mqtt-certificate-client";

const execFile = promisify(execFileCallback);
const GENERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CERTIFICATE_BYTES = 256 * 1024;
const MAX_OPENSSL_OUTPUT_BYTES = 128 * 1024;

export interface MqttIdentityStoreOptions {
  identityRoot: string;
  opensslPath?: string;
  generator?: OpenSslCsrGenerator;
}

export class MqttIdentityStore {
  private readonly opensslPath: string;
  private readonly generator: OpenSslCsrGenerator;

  constructor(private readonly options: MqttIdentityStoreOptions) {
    this.opensslPath = options.opensslPath ?? "openssl";
    this.generator = options.generator ?? new OpenSslCsrGenerator({ opensslPath: this.opensslPath });
  }

  async ensure(
    gatewayId: string,
    mqttCaBundlePem: string,
    issue: (csrPem: string) => Promise<MqttCertificateResponse>
  ): Promise<boolean> {
    validateGatewayId(gatewayId);
    validateCertificateBundle(mqttCaBundlePem);
    await this.ensureLayout();
    if (await this.isCurrentValid(gatewayId)) return false;

    const generationId = randomUUID();
    const pendingRoot = join(this.options.identityRoot, "pending-generations");
    const stagingPath = join(pendingRoot, `.${generationId}.tmp`);
    const pendingPath = join(pendingRoot, generationId);
    await mkdir(stagingPath, { mode: 0o750 });
    await chmod(stagingPath, 0o750);
    try {
      const generated = await this.generator.generate({
        serialNumber: gatewayId,
        privateKeyPath: join(stagingPath, ".gateway.key.tmp"),
        csrPath: join(stagingPath, ".gateway.csr.tmp")
      });
      await rename(join(stagingPath, ".gateway.key.tmp"), join(stagingPath, "gateway.key"));
      await rename(join(stagingPath, ".gateway.csr.tmp"), join(stagingPath, "gateway.csr"));
      await syncDirectory(stagingPath);
      await rename(stagingPath, pendingPath);
      await syncDirectory(pendingRoot);

      const response = await issue(generated.csrPem);
      if (response.gatewayId !== gatewayId) throw new Error("MQTT identity validation failed");
      await this.install(pendingPath, generationId, gatewayId, mqttCaBundlePem, response);
      return true;
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true });
      if ((error as Error).message === "MQTT identity validation failed") throw error;
      throw new Error("MQTT identity installation failed");
    }
  }

  private async install(
    pendingPath: string,
    generationId: string,
    gatewayId: string,
    mqttCaBundlePem: string,
    response: MqttCertificateResponse
  ) {
    const certificatePath = join(pendingPath, "gateway.crt");
    const chainPath = join(pendingPath, "gateway-chain.crt");
    const caPath = join(pendingPath, "mqtt-ca.crt");
    const chain = normalizeChain(response.caChainPem);
    validateCertificateBundle(response.certificatePem);
    validateCertificateBundle(chain);
    const certificateBundle = `${response.certificatePem.trim()}\n${chain}`;
    await writeFileAtomic(certificatePath, certificateBundle, 0o644);
    await writeFileAtomic(chainPath, chain, 0o644);
    await writeFileAtomic(caPath, mqttCaBundlePem, 0o644);
    await this.validateGeneration({ pendingPath, gatewayId, certificatePath, chainPath });

    const generationsRoot = join(this.options.identityRoot, "generations");
    const activePath = join(generationsRoot, generationId);
    const previous = await readOptionalLink(join(this.options.identityRoot, "current"));
    await rename(pendingPath, activePath);
    await syncDirectory(join(this.options.identityRoot, "pending-generations"));
    await syncDirectory(generationsRoot);
    try {
      await replacePointer(this.options.identityRoot, "current", `generations/${generationId}`);
    } catch {
      if (previous) await replacePointer(this.options.identityRoot, "current", previous);
      else await rm(join(this.options.identityRoot, "current"), { force: true });
      throw new Error("MQTT identity installation failed");
    }
  }

  private async isCurrentValid(gatewayId: string) {
    try {
      const target = await readlink(join(this.options.identityRoot, "current"));
      if (!/^generations\/([0-9a-f-]+)$/.test(target) || !GENERATION_ID_PATTERN.test(target.slice("generations/".length))) return false;
      const currentPath = join(this.options.identityRoot, target);
      await assertPlainDirectory(currentPath);
      const certificatePath = join(currentPath, "gateway.crt");
      const chainPath = join(currentPath, "gateway-chain.crt");
      const keyPath = join(currentPath, "gateway.key");
      const mqttCaPath = join(currentPath, "mqtt-ca.crt");
      for (const path of [certificatePath, chainPath, keyPath, mqttCaPath]) await assertPlainFile(path);
      validateCertificateBundle(await readFile(mqttCaPath, "utf8"));
      await this.validateGeneration({ pendingPath: currentPath, gatewayId, certificatePath, chainPath });
      return true;
    } catch {
      return false;
    }
  }

  private async validateGeneration(paths: { pendingPath: string; gatewayId: string; certificatePath: string; chainPath: string }) {
    try {
      const keyPublic = await this.runOpenSsl(["pkey", "-in", join(paths.pendingPath, "gateway.key"), "-pubout"]);
      const certificatePublic = await this.runOpenSsl(["x509", "-in", paths.certificatePath, "-pubkey", "-noout"]);
      if (normalizePem(keyPublic) !== normalizePem(certificatePublic)) throw new Error("key mismatch");
      await this.runOpenSsl(["x509", "-checkend", "0", "-noout", "-in", paths.certificatePath]);
      const subject = await this.runOpenSsl(["x509", "-in", paths.certificatePath, "-noout", "-subject", "-nameopt", "RFC2253"]);
      if (subject.trim() !== `subject=CN=${paths.gatewayId}`) throw new Error("CN mismatch");
      await this.runOpenSsl(["verify", "-purpose", "sslclient", "-CAfile", paths.chainPath, paths.certificatePath]);
    } catch {
      throw new Error("MQTT identity validation failed");
    }
  }

  private async ensureLayout() {
    await mkdir(this.options.identityRoot, { recursive: true, mode: 0o750 });
    await assertPlainDirectory(this.options.identityRoot, "MQTT identity storage directory is invalid");
    await chmod(this.options.identityRoot, 0o750);
    for (const name of ["pending-generations", "generations"]) {
      const path = join(this.options.identityRoot, name);
      await mkdir(path, { recursive: true, mode: 0o750 });
      await assertPlainDirectory(path, "MQTT identity storage directory is invalid");
      await chmod(path, 0o750);
    }
  }

  private async runOpenSsl(args: readonly string[]) {
    const result = await execFile(this.opensslPath, [...args], {
      shell: false, encoding: "utf8", maxBuffer: MAX_OPENSSL_OUTPUT_BYTES, windowsHide: true
    });
    return result.stdout;
  }
}

async function writeFileAtomic(path: string, contents: string, mode: number) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, "wx", mode);
    try {
      await file.writeFile(contents, "utf8");
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function replacePointer(root: string, name: "current", target: string) {
  const temporaryPath = join(root, `.${name}.${randomUUID()}.tmp`);
  try {
    await symlink(target, temporaryPath);
    await rename(temporaryPath, join(root, name));
    await syncDirectory(root);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readOptionalLink(path: string) {
  try {
    return await readlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectory(path: string) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function assertPlainDirectory(path: string, message = "MQTT identity storage directory is invalid") {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(message);
}

async function assertPlainFile(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("MQTT identity validation failed");
}

function validateGatewayId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("MQTT gateway ID is invalid");
}

function validateCertificateBundle(value: string) {
  if (
    typeof value !== "string" || Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > MAX_CERTIFICATE_BYTES ||
    !value.includes("-----BEGIN CERTIFICATE-----") || value.includes("PRIVATE KEY")
  ) {
    throw new Error("MQTT identity validation failed");
  }
}

function normalizeChain(value: string | readonly string[]) {
  const chain = typeof value === "string" ? value : value.join("\n");
  return `${chain.trim()}\n`;
}

function normalizePem(value: string) {
  return value.replace(/\r\n/g, "\n").trim();
}
