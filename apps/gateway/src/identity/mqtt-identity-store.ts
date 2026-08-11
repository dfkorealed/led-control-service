import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readlink, rename as renameFile, rm, symlink } from "node:fs/promises";
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
  rename?: (source: string, destination: string) => Promise<void>;
  syncDirectory?: (path: string) => Promise<void>;
}

export interface MqttIdentityCandidate {
  generationPath: string;
  certificatePath: string;
  keyPath: string;
  caPath: string;
}

export interface PreparedMqttIdentity {
  candidate: MqttIdentityCandidate;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
  isCommitted(): boolean;
}

export class MqttIdentityStore {
  private readonly opensslPath: string;
  private readonly generator: OpenSslCsrGenerator;
  private readonly rename: (source: string, destination: string) => Promise<void>;
  private readonly sync: (path: string) => Promise<void>;

  constructor(private readonly options: MqttIdentityStoreOptions) {
    this.opensslPath = options.opensslPath ?? "openssl";
    this.generator = options.generator ?? new OpenSslCsrGenerator({ opensslPath: this.opensslPath });
    this.rename = options.rename ?? renameFile;
    this.sync = options.syncDirectory ?? syncDirectory;
  }

  async ensure(
    gatewayId: string,
    mqttCaBundlePem: string,
    issue: (csrPem: string) => Promise<MqttCertificateResponse>,
    probe?: (candidate: MqttIdentityCandidate) => Promise<void>,
    force = false
  ): Promise<boolean> {
    let prepared: PreparedMqttIdentity | null = null;
    let committed = false;
    try {
      prepared = await this.prepare(gatewayId, mqttCaBundlePem, issue, force);
      if (!prepared) return false;
      await probe?.(prepared.candidate);
      await prepared.commit();
      committed = true;
      await prepared.finalize();
      return true;
    } catch (error) {
      if (!committed) await prepared?.rollback().catch(() => undefined);
      if (
        (error as Error).message === "MQTT identity validation failed" ||
        (error as Error).message === "MQTT identity permissions are invalid"
      ) throw error;
      throw new Error("MQTT identity installation failed");
    }
  }

  async prepare(
    gatewayId: string,
    mqttCaBundlePem: string,
    issue: (csrPem: string) => Promise<MqttCertificateResponse>,
    force = false
  ): Promise<PreparedMqttIdentity | null> {
    validateGatewayId(gatewayId);
    validateCertificateBundle(mqttCaBundlePem);
    await this.ensureLayout();
    const currentState = await this.currentState(gatewayId);
    if (currentState === "valid" && !force) return null;
    if (currentState === "unsafe") throw new Error("MQTT identity permissions are invalid");

    const generationId = randomUUID();
    const pendingRoot = join(this.options.identityRoot, "pending-generations");
    const stagingPath = join(pendingRoot, `.${generationId}.tmp`);
    const pendingGenerationPath = join(pendingRoot, generationId);
    let candidatePath: string | null = stagingPath;
    await mkdir(stagingPath, { mode: 0o750 });
    await chmod(stagingPath, 0o750);
    try {
      const generated = await this.generator.generate({
        serialNumber: gatewayId,
        privateKeyPath: join(stagingPath, ".gateway.key.tmp"),
        csrPath: join(stagingPath, ".gateway.csr.tmp")
      });
      await this.rename(join(stagingPath, ".gateway.key.tmp"), join(stagingPath, "gateway.key"));
      await this.rename(join(stagingPath, ".gateway.csr.tmp"), join(stagingPath, "gateway.csr"));
      await this.sync(stagingPath);
      await this.rename(stagingPath, pendingGenerationPath);
      candidatePath = pendingGenerationPath;
      await this.sync(pendingRoot);

      const response = await issue(generated.csrPem);
      if (response.gatewayId !== gatewayId) throw new Error("MQTT identity validation failed");
      const certificatePath = join(candidatePath, "gateway.crt");
      const chainPath = join(candidatePath, "gateway-chain.crt");
      const caPath = join(candidatePath, "mqtt-ca.crt");
      const chain = normalizeChain(response.caChainPem);
      validateCertificateBundle(response.certificatePem);
      validateCertificateBundle(chain);
      const certificateBundle = `${response.certificatePem.trim()}\n${chain}`;
      await writeFileAtomic(certificatePath, certificateBundle, 0o644);
      await writeFileAtomic(chainPath, chain, 0o644);
      await writeFileAtomic(caPath, mqttCaBundlePem, 0o644);
      await this.validateGeneration({ pendingPath: candidatePath, gatewayId, certificatePath, chainPath, responseNotAfter: response.notAfter });
      const previous = await readOptionalLink(join(this.options.identityRoot, "current"));
      return this.preparedIdentity({
        generationId,
        pendingPath: candidatePath,
        previous,
        candidate: { generationPath: candidatePath, certificatePath, keyPath: join(candidatePath, "gateway.key"), caPath }
      });
    } catch (error) {
      if (candidatePath) await this.removeGeneration(candidatePath);
      if ((error as Error).message === "MQTT identity validation failed") throw error;
      throw new Error("MQTT identity installation failed");
    }
  }

  private preparedIdentity(input: {
    generationId: string;
    pendingPath: string;
    previous: string | null;
    candidate: MqttIdentityCandidate;
  }): PreparedMqttIdentity {
    const activePath = join(this.options.identityRoot, "generations", input.generationId);
    const candidatePointer = `generations/${input.generationId}`;
    let location: "pending" | "active" | "removed" = "pending";
    let pointerCommitted = false;
    let pointerMayReferenceCandidate = false;
    const restorePreviousPointer = async () => {
      if (input.previous) await this.replacePointer("current", input.previous);
      else {
        await rm(join(this.options.identityRoot, "current"), { force: true });
        await this.sync(this.options.identityRoot);
      }
    };
    const removeCandidate = async () => {
      if (location === "removed") return;
      const path = location === "pending" ? input.pendingPath : activePath;
      await this.removeGeneration(path);
      location = "removed";
    };
    return {
      candidate: input.candidate,
      isCommitted: () => pointerCommitted,
      commit: async () => {
        if (location === "removed") throw new Error("MQTT identity installation failed");
        if (pointerCommitted) return;
        try {
          if (location === "pending") {
            await this.rename(input.pendingPath, activePath);
            location = "active";
            await this.sync(join(this.options.identityRoot, "pending-generations"));
            await this.sync(join(this.options.identityRoot, "generations"));
          }
          await this.replacePointer("current", candidatePointer);
          pointerCommitted = true;
        } catch (error) {
          if (error instanceof PointerReplacementError && error.pointerChanged) {
            pointerMayReferenceCandidate = true;
            try {
              await restorePreviousPointer();
              pointerMayReferenceCandidate = false;
            } catch {
              throw new Error("MQTT identity installation failed");
            }
          }
          throw new Error("MQTT identity installation failed");
        }
      },
      rollback: async () => {
        if (location === "removed") return;
        if (pointerCommitted || pointerMayReferenceCandidate) {
          try {
            await restorePreviousPointer();
            pointerCommitted = false;
            pointerMayReferenceCandidate = false;
          } catch {
            // A failed pointer fsync can leave current pointing at this generation.
            // Keep it intact rather than turning current into a dangling symlink.
            throw new Error("MQTT identity rollback is unsafe");
          }
        }
        await removeCandidate();
      },
      finalize: async () => {
        if (!pointerCommitted || location !== "active") throw new Error("MQTT identity installation failed");
        if (input.previous) {
          await rm(join(this.options.identityRoot, input.previous), { recursive: true, force: true });
          await this.sync(join(this.options.identityRoot, "generations"));
        }
      }
    };
  }

  async currentIdentity(gatewayId: string): Promise<MqttIdentityCandidate & { notAfter: Date }> {
    try {
      await assertPlainDirectory(this.options.identityRoot, "MQTT identity storage directory is invalid", 0o750);
      const target = await readlink(join(this.options.identityRoot, "current"));
      if (!/^generations\/([0-9a-f-]+)$/.test(target) || !GENERATION_ID_PATTERN.test(target.slice("generations/".length))) {
        throw new Error("invalid current pointer");
      }
      const generationPath = join(this.options.identityRoot, target);
      await assertPlainDirectory(generationPath, "MQTT identity storage directory is invalid", 0o750);
      const certificatePath = join(generationPath, "gateway.crt");
      const chainPath = join(generationPath, "gateway-chain.crt");
      const keyPath = join(generationPath, "gateway.key");
      const caPath = join(generationPath, "mqtt-ca.crt");
      await assertPlainFile(certificatePath, 0o644);
      await assertPlainFile(chainPath, 0o644);
      await assertPlainFile(keyPath, 0o600);
      await assertPlainFile(caPath, 0o644);
      validateCertificateBundle(await readFile(caPath, "utf8"));
      const notAfter = await this.validateGeneration({ pendingPath: generationPath, gatewayId, certificatePath, chainPath });
      return { generationPath, certificatePath, keyPath, caPath, notAfter };
    } catch (error) {
      if (error instanceof MqttIdentityPermissionsError) throw error;
      throw new Error("MQTT identity validation failed");
    }
  }

  private async currentState(gatewayId: string): Promise<"valid" | "invalid" | "unsafe"> {
    try {
      await this.currentIdentity(gatewayId);
      return "valid";
    } catch (error) {
      if (error instanceof MqttIdentityPermissionsError) return "unsafe";
      return "invalid";
    }
  }

  private async validateGeneration(paths: {
    pendingPath: string;
    gatewayId: string;
    certificatePath: string;
    chainPath: string;
    responseNotAfter?: string;
  }): Promise<Date> {
    try {
      const keyPublic = await this.runOpenSsl(["pkey", "-in", join(paths.pendingPath, "gateway.key"), "-pubout"]);
      const certificatePublic = await this.runOpenSsl(["x509", "-in", paths.certificatePath, "-pubkey", "-noout"]);
      if (normalizePem(keyPublic) !== normalizePem(certificatePublic)) throw new Error("key mismatch");
      await this.runOpenSsl(["verify", "-purpose", "sslclient", "-CAfile", paths.chainPath, paths.certificatePath]);
      const validity = parseCertificateValidity(await this.runOpenSsl([
        "x509", "-in", paths.certificatePath, "-noout", "-startdate", "-enddate"
      ]));
      const now = Date.now();
      if (validity.notBefore >= validity.notAfter || validity.notBefore > now || validity.notAfter <= now) {
        throw new Error("certificate is not currently valid");
      }
      if (paths.responseNotAfter !== undefined && new Date(paths.responseNotAfter).getTime() !== validity.notAfter) {
        throw new Error("certificate notAfter metadata mismatch");
      }
      const subject = await this.runOpenSsl(["x509", "-in", paths.certificatePath, "-noout", "-subject", "-nameopt", "RFC2253"]);
      if (subject.trim() !== `subject=CN=${paths.gatewayId}`) throw new Error("CN mismatch");
      return new Date(validity.notAfter);
    } catch {
      throw new Error("MQTT identity validation failed");
    }
  }

  private async ensureLayout() {
    await mkdir(this.options.identityRoot, { recursive: true, mode: 0o750 });
    await assertPlainDirectory(this.options.identityRoot, "MQTT identity storage directory is invalid", 0o750);
    for (const name of ["pending-generations", "generations"]) {
      const path = join(this.options.identityRoot, name);
      await mkdir(path, { recursive: true, mode: 0o750 });
      await assertPlainDirectory(path, "MQTT identity storage directory is invalid", 0o750);
    }
  }

  private async runOpenSsl(args: readonly string[]) {
    const result = await execFile(this.opensslPath, [...args], {
      shell: false, encoding: "utf8", maxBuffer: MAX_OPENSSL_OUTPUT_BYTES, windowsHide: true
    });
    return result.stdout;
  }

  private async removeGeneration(path: string) {
    await rm(path, { recursive: true, force: true });
    await this.sync(dirname(path));
  }

  private async replacePointer(name: "current", target: string) {
    const temporaryPath = join(this.options.identityRoot, `.${name}.${randomUUID()}.tmp`);
    let pointerChanged = false;
    try {
      await symlink(target, temporaryPath);
      await this.rename(temporaryPath, join(this.options.identityRoot, name));
      pointerChanged = true;
      await this.sync(this.options.identityRoot);
    } catch {
      await rm(temporaryPath, { force: true });
      throw new PointerReplacementError(pointerChanged);
    }
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
    await renameFile(temporaryPath, path);
    await syncDirectory(dirname(path));
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

async function assertPlainDirectory(path: string, message = "MQTT identity storage directory is invalid", mode?: number) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(message);
  if (mode !== undefined && (metadata.mode & 0o777) !== mode) throw new MqttIdentityPermissionsError();
}

async function assertPlainFile(path: string, mode?: number) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("MQTT identity validation failed");
  if (mode !== undefined && (metadata.mode & 0o777) !== mode) throw new MqttIdentityPermissionsError();
}

class MqttIdentityPermissionsError extends Error {
  constructor() {
    super("MQTT identity permissions are invalid");
  }
}

class PointerReplacementError extends Error {
  constructor(readonly pointerChanged: boolean) {
    super("MQTT identity pointer replacement failed");
  }
}

function parseCertificateValidity(output: string) {
  const values = new Map(output.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const notBefore = new Date(values.get("notBefore") ?? "").getTime();
  const notAfter = new Date(values.get("notAfter") ?? "").getTime();
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) throw new Error("certificate dates are invalid");
  return { notBefore, notAfter };
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
