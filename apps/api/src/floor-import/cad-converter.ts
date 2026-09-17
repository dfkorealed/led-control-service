import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export interface CadConversionRequest {
  inputPath: string;
  outputPath: string;
  abortSignal?: AbortSignal;
}

export interface CadConversionResult {
  outputPath: string;
  outputBytes: number;
}

export interface CadConverter {
  convert(request: CadConversionRequest): Promise<CadConversionResult>;
}

export interface ArgvCadConverterOptions {
  executable: string;
  argv: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  execution?: CadConverterExecutionPolicy;
}

export type CadConverterExecutionPolicy =
  | {
    mode: "linux-resource-limited";
  }
  | {
    mode: "macos-development-polling";
    acknowledgeNonProductionRisk: true;
  };

export interface CadConverterLaunch {
  executable: string;
  argv: string[];
  pollOutput: boolean;
}

export interface CadLimiterExecutableIdentity {
  realPath: string;
  regularFile: boolean;
  symbolicLink: boolean;
  uid: number;
  mode: number;
}

export interface CadLimiterExecutableInspector {
  inspect(path: string): CadLimiterExecutableIdentity;
}

const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const UNSAFE_ARGV = /[;|&`<>\r\n]|\$\(/;
const SUPPORTED_UNIX_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux"]);
const OUTPUT_POLL_INTERVAL_MS = 20;
const GNU_PRLIMIT_PATH = "/usr/bin/prlimit";
const CONVERTER_ADDRESS_SPACE_BYTES = 512 * 1024 * 1024;
const CONVERTER_CPU_SECONDS = 60;
const CONVERTER_OPEN_FILES = 64;
const CONVERTER_PROCESSES = 32;
const CONVERTER_PATH = "/opt/cad-converter/bin:/usr/local/bin:/usr/bin:/bin";
const DEFAULT_LIMITER_INSPECTOR: CadLimiterExecutableInspector = {
  inspect(path) {
    const identity = lstatSync(path);
    return {
      realPath: realpathSync.native(path),
      regularFile: identity.isFile(),
      symbolicLink: identity.isSymbolicLink(),
      uid: identity.uid,
      mode: identity.mode
    };
  }
};

export function assertSupportedCadConverterPlatform(platform: NodeJS.Platform): void {
  if (!SUPPORTED_UNIX_PLATFORMS.has(platform)) throw new Error(`Unsupported CAD converter platform: ${platform}; Unix process groups are required`);
}

function validateExecutable(executable: string, label: string): void {
  if (!isAbsolute(executable) || executable.includes("\0") || SHELL_EXECUTABLES.has(basename(executable).toLowerCase())) {
    throw new Error(`Shell or non-absolute ${label} executable is unsafe`);
  }
}

function attestGnuPrlimit(inspector: CadLimiterExecutableInspector): void {
  let identity: CadLimiterExecutableIdentity;
  try {
    identity = inspector.inspect(GNU_PRLIMIT_PATH);
  } catch (error) {
    throw new Error(`GNU prlimit identity attestation failed: ${(error as Error).message}`);
  }
  if (identity.realPath !== GNU_PRLIMIT_PATH || !identity.regularFile || identity.symbolicLink || identity.uid !== 0 ||
      (identity.mode & 0o022) !== 0 || (identity.mode & 0o111) === 0) {
    throw new Error("GNU prlimit identity attestation rejected the trusted executable");
  }
}

function validateConfiguration(
  options: ArgvCadConverterOptions,
  platform: NodeJS.Platform,
  limiterInspector: CadLimiterExecutableInspector
): void {
  assertSupportedCadConverterPlatform(platform);
  validateExecutable(options.executable, "CAD converter");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Invalid CAD converter time limit");
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) throw new Error("Invalid CAD converter output limit");
  if (!options.argv.length || options.argv.some(argument => !argument || argument.includes("\0") || UNSAFE_ARGV.test(argument))) {
    throw new Error("Unsafe CAD converter argv configuration");
  }
  const template = options.argv.join("\0");
  if ((template.match(/\{input\}/g) ?? []).length !== 1 || (template.match(/\{output\}/g) ?? []).length !== 1) {
    throw new Error("CAD converter argv must contain one input and one output placeholder");
  }
  if (!options.execution) throw new Error("CAD converter execution policy with a hard resource limiter is required");
  if (platform === "linux") {
    if (options.execution.mode !== "linux-resource-limited") throw new Error("Production Linux CAD conversion requires a hard resource limiter");
    attestGnuPrlimit(limiterInspector);
  } else if (options.execution.mode !== "macos-development-polling" || options.execution.acknowledgeNonProductionRisk !== true) {
    throw new Error("macOS CAD conversion only supports explicitly acknowledged non-production output polling");
  }
}

export function buildCadConverterLaunch(
  options: ArgvCadConverterOptions,
  converterArgv: readonly string[],
  platform: NodeJS.Platform = process.platform,
  limiterInspector: CadLimiterExecutableInspector = DEFAULT_LIMITER_INSPECTOR
): CadConverterLaunch {
  validateConfiguration(options, platform, limiterInspector);
  if (options.execution?.mode === "linux-resource-limited") {
    return {
      executable: GNU_PRLIMIT_PATH,
      argv: [
        `--as=${CONVERTER_ADDRESS_SPACE_BYTES}:${CONVERTER_ADDRESS_SPACE_BYTES}`,
        `--cpu=${CONVERTER_CPU_SECONDS}:${CONVERTER_CPU_SECONDS}`,
        `--nofile=${CONVERTER_OPEN_FILES}:${CONVERTER_OPEN_FILES}`,
        `--nproc=${CONVERTER_PROCESSES}:${CONVERTER_PROCESSES}`,
        `--fsize=${options.maxOutputBytes}:${options.maxOutputBytes}`,
        "--", options.executable, ...converterArgv
      ],
      pollOutput: false
    };
  }
  return { executable: options.executable, argv: [...converterArgv], pollOutput: true };
}

export class ArgvCadConverter implements CadConverter {
  private readonly options: ArgvCadConverterOptions;
  private readonly limiterInspector: CadLimiterExecutableInspector;

  constructor(options: ArgvCadConverterOptions, dependencies: { limiterInspector?: CadLimiterExecutableInspector } = {}) {
    this.limiterInspector = dependencies.limiterInspector ?? DEFAULT_LIMITER_INSPECTOR;
    validateConfiguration(options, process.platform, this.limiterInspector);
    this.options = {
      ...options,
      argv: [...options.argv],
      execution: options.execution ? { ...options.execution } : undefined
    };
  }

  async convert(request: CadConversionRequest): Promise<CadConversionResult> {
    if (!isAbsolute(request.inputPath) || !isAbsolute(request.outputPath) || request.inputPath.includes("\0") || request.outputPath.includes("\0")) {
      throw new Error("CAD converter paths must be absolute");
    }
    if (resolve(request.inputPath) === resolve(request.outputPath)) throw new Error("CAD converter input and output paths must differ");
    const input = await stat(request.inputPath);
    if (!input.isFile()) throw new Error("CAD converter input must be a regular file");
    await unlink(request.outputPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    if (request.abortSignal?.aborted) throw new Error("CAD conversion aborted");
    const argv = this.options.argv.map(argument => argument
      .replace("{input}", request.inputPath)
      .replace("{output}", request.outputPath));
    const launch = buildCadConverterLaunch(this.options, argv, process.platform, this.limiterInspector);

    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        // Linux production starts the converter under a kernel resource limiter.
        // detached also makes the wrapper and every descendant one killable group.
        const child = spawn(launch.executable, launch.argv, {
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: CONVERTER_PATH,
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            TMPDIR: dirname(request.outputPath)
          }
        });
        let settledError: Error | null = null;
        let processOutputBytes = 0;
        let stderr = "";
        const killTree = () => {
          if (child.pid !== undefined) {
            try { process.kill(-child.pid, "SIGKILL"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") settledError ??= error as Error; }
          }
          child.stdout.destroy();
          child.stderr.destroy();
          if (!child.killed) child.kill("SIGKILL");
        };
        const fail = (error: Error) => {
          settledError ??= error;
          killTree();
        };
        const timer = setTimeout(() => fail(new Error("CAD conversion time limit exceeded")), this.options.timeoutMs);
        const outputPoller = launch.pollOutput ? setInterval(() => {
          try {
            const output = lstatSync(request.outputPath);
            if (!output.isFile() || output.isSymbolicLink()) fail(new Error("CAD converter output must be a regular file"));
            else if (output.size > this.options.maxOutputBytes) fail(new Error("CAD converter output limit exceeded"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(error as Error);
          }
        }, OUTPUT_POLL_INTERVAL_MS) : undefined;
        const onAbort = () => fail(new Error("CAD conversion aborted"));
        request.abortSignal?.addEventListener("abort", onAbort, { once: true });
        const onData = (chunk: Buffer, capture: boolean) => {
          processOutputBytes += chunk.byteLength;
          if (capture && stderr.length < 4096) stderr += chunk.toString("utf8", 0, Math.min(chunk.length, 4096 - stderr.length));
          if (processOutputBytes > this.options.maxOutputBytes) fail(new Error("CAD converter process output limit exceeded"));
        };
        child.stdout.on("data", chunk => onData(chunk as Buffer, false));
        child.stderr.on("data", chunk => onData(chunk as Buffer, true));
        child.once("error", error => fail(new Error(`CAD converter failed to launch: ${error.message}`)));
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          if (outputPoller) clearInterval(outputPoller);
          request.abortSignal?.removeEventListener("abort", onAbort);
          if (settledError) rejectPromise(settledError);
          else if (signal === "SIGXFSZ" || /EFBIG|file too large/i.test(stderr)) rejectPromise(new Error("CAD converter output limit exceeded"));
          else if (code !== 0) rejectPromise(new Error(`CAD converter exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
          else resolvePromise();
        });
      });

      const output = await lstat(request.outputPath).catch(error => {
        throw new Error(`CAD converter did not create output: ${(error as Error).message}`);
      });
      if (!output.isFile() || output.isSymbolicLink()) throw new Error("CAD converter output must be a regular file");
      if (output.size > this.options.maxOutputBytes) throw new Error("CAD converter output limit exceeded");
      return { outputPath: request.outputPath, outputBytes: output.size };
    } catch (error) {
      await unlink(request.outputPath).catch(unlinkError => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      });
      throw error;
    }
  }
}
