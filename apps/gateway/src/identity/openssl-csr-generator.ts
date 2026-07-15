import { execFile as execFileCallback } from "node:child_process";
import { chmod, open, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SERIAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_OPENSSL_OUTPUT_BYTES = 64 * 1024;

export type OpenSslCommandRunner = (args: readonly string[]) => Promise<void>;

export interface GenerateCsrInput {
  serialNumber: string;
  privateKeyPath: string;
  csrPath: string;
}

export class OpenSslCsrGenerator {
  private readonly run: OpenSslCommandRunner;

  constructor(options: { opensslPath?: string; run?: OpenSslCommandRunner } = {}) {
    this.run = options.run ?? createOpenSslCommandRunner(options.opensslPath ?? "openssl");
  }

  async generate(input: GenerateCsrInput): Promise<{ csrPem: string }> {
    if (!SERIAL_PATTERN.test(input.serialNumber)) {
      throw new Error("serialNumber has an invalid format");
    }

    try {
      await createPrivateKeyFile(input.privateKeyPath);
      await this.run([
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-out",
        input.privateKeyPath
      ]);
      await chmodAndSync(input.privateKeyPath, 0o600);
      await this.run([
        "req",
        "-new",
        "-sha256",
        "-key",
        input.privateKeyPath,
        "-out",
        input.csrPath,
        "-subj",
        `/CN=${input.serialNumber}`
      ]);
      await chmodAndSync(input.csrPath, 0o644);
      const csrPem = await readFile(input.csrPath, "utf8");
      if (!csrPem.includes("-----BEGIN CERTIFICATE REQUEST-----") || csrPem.includes("PRIVATE KEY")) {
        throw new Error("invalid CSR output");
      }
      return { csrPem };
    } catch (error) {
      if (error instanceof Error && error.message === "serialNumber has an invalid format") throw error;
      throw new Error("OpenSSL device identity generation failed");
    }
  }
}

async function createPrivateKeyFile(path: string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.chmod(0o600);
    await file.sync();
  } finally {
    await file.close();
  }
}

function createOpenSslCommandRunner(opensslPath: string): OpenSslCommandRunner {
  return async (args) => {
    await execFile(opensslPath, [...args], {
      shell: false,
      encoding: "utf8",
      maxBuffer: MAX_OPENSSL_OUTPUT_BYTES,
      windowsHide: true
    });
  };
}

async function chmodAndSync(path: string, mode: number) {
  await chmod(path, mode);
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
