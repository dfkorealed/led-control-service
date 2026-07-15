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

  async installIdentityBundle(bundle: IdentityBundle): Promise<void> {
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

    if (await pointsTo(join(this.options.identityRoot, "pending"), pendingTarget)) {
      await rm(join(this.options.identityRoot, "pending"), { force: true });
      await this.syncDirectory(this.options.identityRoot);
    }
  }

  private async ensureLayout() {
    await mkdir(this.options.identityRoot, { recursive: true, mode: 0o750 });
    await assertPlainDirectory(this.options.identityRoot, "identity storage directory is invalid");
    await chmod(this.options.identityRoot, 0o750);
    for (const name of ["pending-generations", "generations"]) {
      const path = join(this.options.identityRoot, name);
      await mkdir(path, { recursive: true, mode: 0o750 });
      await assertPlainDirectory(path, "identity storage directory is invalid");
      await chmod(path, 0o750);
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

  private async validateBundle(paths: { csrPath: string; certificatePath: string; deviceCaPath: string }) {
    try {
      await this.runOpenSsl(["req", "-verify", "-noout", "-in", paths.csrPath]);
      const csrPublicKey = await this.runOpenSsl(["req", "-in", paths.csrPath, "-pubkey", "-noout"]);
      const certificatePublicKey = await this.runOpenSsl([
        "x509", "-in", paths.certificatePath, "-pubkey", "-noout"
      ]);
      if (normalizePem(csrPublicKey) !== normalizePem(certificatePublicKey)) {
        throw new Error("public key mismatch");
      }
      await this.runOpenSsl(["x509", "-checkend", "0", "-noout", "-in", paths.certificatePath]);
      await this.runOpenSsl([
        "verify", "-purpose", "sslclient", "-CAfile", paths.deviceCaPath, paths.certificatePath
      ]);
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

async function assertPlainDirectory(path: string, message = "pending device identity is invalid") {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(message);
  }
}

async function pointsTo(path: string, expectedTarget: string) {
  try {
    return (await readlink(path)) === expectedTarget;
  } catch {
    return false;
  }
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
