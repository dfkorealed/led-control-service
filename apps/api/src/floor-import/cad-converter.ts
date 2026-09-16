import { spawn } from "node:child_process";
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

function validateConfiguration(options: ArgvCadConverterOptions): void {
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

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(this.options.executable, argv, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let settledError: Error | null = null;
      let processOutputBytes = 0;
      let stderr = "";
      const fail = (error: Error) => {
        settledError ??= error;
        if (!child.killed) child.kill("SIGKILL");
      };
      const timer = setTimeout(() => fail(new Error("CAD conversion time limit exceeded")), this.options.timeoutMs);
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
  }
}
