import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename as renameFile,
  rm,
  symlink
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { OpenSslCsrGenerator } from "./openssl-csr-generator";

const execFile = promisify(execFileCallback);
const GENERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CERTIFICATE_BYTES = 128 * 1024;
const MAX_OPENSSL_OUTPUT_BYTES = 128 * 1024;

export interface IdentityBundle {
  deviceCertificatePem: string;
  deviceCaBundlePem: string;
  apiCaBundlePem: string;
  mqttCaBundlePem: string;
}

export interface DeviceIdentityPaths {
  generationPath: string;
  certificatePath: string;
  privateKeyPath: string;
  deviceCaPath: string;
  apiCaPath: string;
  mqttCaPath: string;
  notAfter: Date;
}

export interface InstallIdentityOptions {
  activate?: (candidate: Omit<DeviceIdentityPaths, "notAfter">) => Promise<void>;
}

export interface KeyMaterialStoreOptions {
  identityRoot: string;
  opensslPath?: string;
  generator?: OpenSslCsrGenerator;
  rename?: (source: string, destination: string) => Promise<void>;
  syncDirectory?: (path: string) => Promise<void>;
}

export class KeyMaterialStore {
  private readonly generator: OpenSslCsrGenerator;
  private readonly opensslPath: string;
  private readonly rename: (source: string, destination: string) => Promise<void>;
  private readonly syncDirectory: (path: string) => Promise<void>;

  constructor(private readonly options: KeyMaterialStoreOptions) {
    this.opensslPath = options.opensslPath ?? "openssl";
    this.generator = options.generator ?? new OpenSslCsrGenerator({ opensslPath: this.opensslPath });
    this.rename = options.rename ?? renameFile;
    this.syncDirectory = options.syncDirectory ?? syncDirectory;
  }

  async generateDeviceIdentity(serialNumber: string): Promise<{ csrPem: string }> {
    await this.ensureLayout();
    const generationId = randomUUID();
    const pendingRoot = join(this.options.identityRoot, "pending-generations");
    const stagingPath = join(pendingRoot, `.${generationId}.tmp`);
    const generationPath = join(pendingRoot, generationId);
    await mkdir(stagingPath, { mode: 0o750 });
    await chmod(stagingPath, 0o750);

    try {
      const temporaryKeyPath = join(stagingPath, ".device.key.tmp");
      const temporaryCsrPath = join(stagingPath, ".device.csr.tmp");
      const generated = await this.generator.generate({
        serialNumber,
        privateKeyPath: temporaryKeyPath,
        csrPath: temporaryCsrPath
      });
      await this.rename(temporaryKeyPath, join(stagingPath, "device.key"));
      await this.rename(temporaryCsrPath, join(stagingPath, "device.csr"));
      await this.syncDirectory(stagingPath);
      await this.rename(stagingPath, generationPath);
      await this.syncDirectory(pendingRoot);
      await this.replacePointer("pending", `pending-generations/${generationId}`);
      return { csrPem: generated.csrPem };
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  async installIdentityBundle(bundle: IdentityBundle, options: InstallIdentityOptions = {}): Promise<void> {
    await this.ensureLayout();
    const pendingTarget = await this.readPendingTarget();
    const generationId = pendingTarget.slice("pending-generations/".length);
    const pendingPath = join(this.options.identityRoot, pendingTarget);
    await assertPlainDirectory(pendingPath);

    const certificatePath = join(pendingPath, "device.crt");
    const deviceCaPath = join(pendingPath, "device-ca.crt");
    const apiCaPath = join(pendingPath, "api-ca.crt");
    const mqttCaPath = join(pendingPath, "mqtt-ca.crt");
    validateCertificatePem(bundle.deviceCertificatePem);
    validateCertificatePem(bundle.deviceCaBundlePem);
    validateCertificatePem(bundle.apiCaBundlePem);
    validateCertificatePem(bundle.mqttCaBundlePem);

    await writeFileAtomic(certificatePath, bundle.deviceCertificatePem, 0o644, this.rename, this.syncDirectory);
    await writeFileAtomic(deviceCaPath, bundle.deviceCaBundlePem, 0o644, this.rename, this.syncDirectory);
    await writeFileAtomic(apiCaPath, bundle.apiCaBundlePem, 0o644, this.rename, this.syncDirectory);
    await writeFileAtomic(mqttCaPath, bundle.mqttCaBundlePem, 0o644, this.rename, this.syncDirectory);
    await this.validateBundle({
      csrPath: join(pendingPath, "device.csr"),
      certificatePath,
      deviceCaPath
    });

    const generationsRoot = join(this.options.identityRoot, "generations");
    const activeGenerationPath = join(generationsRoot, generationId);
    const previousCurrentTarget = await readOptionalLink(join(this.options.identityRoot, "current"));
    await this.rename(pendingPath, activeGenerationPath);
    await this.syncDirectory(join(this.options.identityRoot, "pending-generations"));
    await this.syncDirectory(generationsRoot);

    try {
      await this.replacePointer("current", `generations/${generationId}`);
    } catch (error) {
      let pointerRestored = !(error instanceof PointerReplacementError) || !error.pointerChanged;
      if (!pointerRestored) {
        try {
          if (previousCurrentTarget === null) {
            await rm(join(this.options.identityRoot, "current"), { force: true });
            await this.syncDirectory(this.options.identityRoot);
          } else {
            await this.replacePointer("current", previousCurrentTarget);
          }
          pointerRestored = true;
        } catch {
          pointerRestored = false;
        }
      }

      if (pointerRestored) {
        try {
          await this.rename(activeGenerationPath, pendingPath);
          await this.syncDirectory(generationsRoot);
          await this.syncDirectory(join(this.options.identityRoot, "pending-generations"));
        } catch {
          // A failed generation rollback leaves the active directory intact or back in pending.
        }
      }
      throw new Error("identity activation failed");
    }

    const candidate = {
      generationPath: activeGenerationPath,
      certificatePath,
      privateKeyPath: join(activeGenerationPath, "device.key"),
      deviceCaPath: join(activeGenerationPath, "device-ca.crt"),
      apiCaPath: join(activeGenerationPath, "api-ca.crt"),
      mqttCaPath: join(activeGenerationPath, "mqtt-ca.crt")
    };
    try {
      await options.activate?.(candidate);
    } catch {
      try {
        if (previousCurrentTarget === null) {
          await rm(join(this.options.identityRoot, "current"), { force: true });
          await this.syncDirectory(this.options.identityRoot);
        } else {
          await this.replacePointer("current", previousCurrentTarget);
        }
        await rm(activeGenerationPath, { recursive: true, force: true });
        await this.syncDirectory(generationsRoot);
      } catch {
        // Preserve the last durable pointer when rollback itself cannot be completed.
      }
      throw new Error("identity activation failed");
    }

    if (await pointsTo(join(this.options.identityRoot, "pending"), pendingTarget)) {
      await rm(join(this.options.identityRoot, "pending"), { force: true });
      await this.syncDirectory(this.options.identityRoot);
    }
    if (previousCurrentTarget !== null) {
      await rm(join(this.options.identityRoot, previousCurrentTarget), { recursive: true, force: true });
      await this.syncDirectory(generationsRoot);
    }
  }

  async currentIdentity(): Promise<DeviceIdentityPaths> {
    try {
      await assertPlainDirectory(this.options.identityRoot, "device identity validation failed", 0o750);
      const target = await readlink(join(this.options.identityRoot, "current"));
      if (!/^generations\/([0-9a-f-]+)$/.test(target) || !GENERATION_ID_PATTERN.test(target.slice("generations/".length))) {
        throw new Error("invalid current pointer");
      }
      const generationPath = join(this.options.identityRoot, target);
      await assertPlainDirectory(generationPath, "device identity validation failed", 0o750);
      const certificatePath = join(generationPath, "device.crt");
      const privateKeyPath = join(generationPath, "device.key");
      const csrPath = join(generationPath, "device.csr");
      const deviceCaPath = join(generationPath, "device-ca.crt");
      const apiCaPath = join(generationPath, "api-ca.crt");
      const mqttCaPath = join(generationPath, "mqtt-ca.crt");
      await assertPlainFile(privateKeyPath, 0o600);
      await Promise.all([certificatePath, csrPath, deviceCaPath, apiCaPath, mqttCaPath].map((path) => assertPlainFile(path, 0o644)));
      const notAfter = await this.validateBundle({ csrPath, certificatePath, deviceCaPath });
      return { generationPath, certificatePath, privateKeyPath, deviceCaPath, apiCaPath, mqttCaPath, notAfter };
    } catch (error) {
      if (error instanceof DeviceIdentityPermissionsError) throw error;
      throw new Error("device identity validation failed");
    }
  }

  private async ensureLayout() {
    await mkdir(this.options.identityRoot, { recursive: true, mode: 0o750 });
    await assertPlainDirectory(this.options.identityRoot, "identity storage directory is invalid", 0o750);
    for (const name of ["pending-generations", "generations"]) {
      const path = join(this.options.identityRoot, name);
      await mkdir(path, { recursive: true, mode: 0o750 });
      await assertPlainDirectory(path, "identity storage directory is invalid", 0o750);
    }
  }

  private async readPendingTarget() {
    let target: string;
    try {
      target = await readlink(join(this.options.identityRoot, "pending"));
    } catch {
      throw new Error("pending device identity is not available");
    }
    const match = /^pending-generations\/([0-9a-f-]+)$/.exec(target);
    if (!match || !GENERATION_ID_PATTERN.test(match[1])) {
      throw new Error("pending device identity is invalid");
    }
    return target;
  }

  private async replacePointer(name: "pending" | "current", target: string) {
    const pointerPath = join(this.options.identityRoot, name);
    const temporaryPointerPath = join(this.options.identityRoot, `.${name}.${randomUUID()}.tmp`);
    let pointerChanged = false;
    try {
      await symlink(target, temporaryPointerPath);
      await this.rename(temporaryPointerPath, pointerPath);
      pointerChanged = true;
      await this.syncDirectory(this.options.identityRoot);
    } catch {
      await rm(temporaryPointerPath, { force: true });
      throw new PointerReplacementError(pointerChanged);
    }
  }

  private async validateBundle(paths: { csrPath: string; certificatePath: string; deviceCaPath: string }): Promise<Date> {
    try {
      await this.runOpenSsl(["req", "-verify", "-noout", "-in", paths.csrPath]);
      const csrPublicKey = await this.runOpenSsl(["req", "-in", paths.csrPath, "-pubkey", "-noout"]);
      const certificatePublicKey = await this.runOpenSsl([
        "x509", "-in", paths.certificatePath, "-pubkey", "-noout"
      ]);
      if (normalizePem(csrPublicKey) !== normalizePem(certificatePublicKey)) {
        throw new Error("public key mismatch");
      }
      const csrSubject = await this.runOpenSsl(["req", "-in", paths.csrPath, "-noout", "-subject", "-nameopt", "RFC2253"]);
      const certificateSubject = await this.runOpenSsl(["x509", "-in", paths.certificatePath, "-noout", "-subject", "-nameopt", "RFC2253"]);
      if (csrSubject.trim() !== certificateSubject.trim()) throw new Error("CN mismatch");
      await this.runOpenSsl([
        "verify", "-purpose", "sslclient", "-CAfile", paths.deviceCaPath, paths.certificatePath
      ]);
      const validity = parseCertificateValidity(await this.runOpenSsl([
        "x509", "-in", paths.certificatePath, "-noout", "-startdate", "-enddate"
      ]));
      const now = Date.now();
      if (validity.notBefore >= validity.notAfter || validity.notBefore > now || validity.notAfter <= now) {
        throw new Error("certificate is not currently valid");
      }
      return new Date(validity.notAfter);
    } catch {
      throw new Error("identity bundle validation failed");
    }
  }

  private async runOpenSsl(args: readonly string[]) {
    const result = await execFile(this.opensslPath, [...args], {
      shell: false,
      encoding: "utf8",
      maxBuffer: MAX_OPENSSL_OUTPUT_BYTES,
      windowsHide: true
    });
    return result.stdout;
  }
}

async function writeFileAtomic(
  path: string,
  contents: string,
  mode: number,
  rename: (source: string, destination: string) => Promise<void>,
  sync: (path: string) => Promise<void>
) {
  const directory = join(path, "..");
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
    await sync(directory);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

class PointerReplacementError extends Error {
  constructor(readonly pointerChanged: boolean) {
    super("identity pointer replacement failed");
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

async function assertPlainDirectory(path: string, message = "pending device identity is invalid", mode?: number) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(message);
  }
  if (mode !== undefined && (metadata.mode & 0o777) !== mode) throw new DeviceIdentityPermissionsError();
}

async function assertPlainFile(path: string, mode?: number) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("device identity validation failed");
  if (mode !== undefined && (metadata.mode & 0o777) !== mode) throw new DeviceIdentityPermissionsError();
}

async function pointsTo(path: string, expectedTarget: string) {
  try {
    return (await readlink(path)) === expectedTarget;
  } catch {
    return false;
  }
}

class DeviceIdentityPermissionsError extends Error {
  constructor() {
    super("device identity permissions are invalid");
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

function validateCertificatePem(value: string) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_CERTIFICATE_BYTES ||
    !value.includes("-----BEGIN CERTIFICATE-----") ||
    value.includes("PRIVATE KEY")
  ) {
    throw new Error("identity bundle validation failed");
  }
}

function normalizePem(value: string) {
  return value.replace(/\r\n/g, "\n").trim();
}
