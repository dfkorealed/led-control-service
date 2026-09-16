import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { lstat, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

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
}

const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const UNSAFE_ARGV = /[;|&`<>\r\n]|\$\(/;
const SUPPORTED_UNIX_PLATFORMS = new Set<NodeJS.Platform>(["aix", "darwin", "freebsd", "linux", "openbsd", "sunos"]);
const OUTPUT_POLL_INTERVAL_MS = 20;

export function assertSupportedCadConverterPlatform(platform: NodeJS.Platform): void {
  if (!SUPPORTED_UNIX_PLATFORMS.has(platform)) throw new Error(`Unsupported CAD converter platform: ${platform}; Unix process groups are required`);
}

function validateConfiguration(options: ArgvCadConverterOptions): void {
  assertSupportedCadConverterPlatform(process.platform);
  if (!isAbsolute(options.executable) || options.executable.includes("\0") || SHELL_EXECUTABLES.has(basename(options.executable).toLowerCase())) {
    throw new Error("Shell or non-absolute CAD converter executable is unsafe");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Invalid CAD converter time limit");
  if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) throw new Error("Invalid CAD converter output limit");
  if (!options.argv.length || options.argv.some(argument => !argument || argument.includes("\0") || UNSAFE_ARGV.test(argument))) {
    throw new Error("Unsafe CAD converter argv configuration");
  }
  const template = options.argv.join("\0");
  if ((template.match(/\{input\}/g) ?? []).length !== 1 || (template.match(/\{output\}/g) ?? []).length !== 1) {
    throw new Error("CAD converter argv must contain one input and one output placeholder");
  }
}

export class ArgvCadConverter implements CadConverter {
  private readonly options: ArgvCadConverterOptions;

  constructor(options: ArgvCadConverterOptions) {
    validateConfiguration(options);
    this.options = { ...options, argv: [...options.argv] };
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

    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        // Production support is intentionally Unix-only: detached creates a new
        // process group whose negative PID can be killed with all descendants.
        const child = spawn(this.options.executable, argv, { detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
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
        const outputPoller = setInterval(() => {
          try {
            const output = lstatSync(request.outputPath);
            if (!output.isFile() || output.isSymbolicLink()) fail(new Error("CAD converter output must be a regular file"));
            else if (output.size > this.options.maxOutputBytes) fail(new Error("CAD converter output limit exceeded"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(error as Error);
          }
        }, OUTPUT_POLL_INTERVAL_MS);
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
        child.once("close", code => {
          clearTimeout(timer);
          clearInterval(outputPoller);
          request.abortSignal?.removeEventListener("abort", onAbort);
          if (settledError) rejectPromise(settledError);
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
