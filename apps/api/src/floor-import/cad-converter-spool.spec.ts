import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpoolCadConverter } from "./cad-converter-spool";
import { attestCadConverterExecutable, processCadSidecarJob, runCadConverterSidecar } from "./cad-converter-sidecar";

describe("credential-free CAD converter spool boundary", () => {
  let directory: string;
  let spoolRoot: string;
  let executable: string;
  let digest: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cad-sidecar-"));
    spoolRoot = join(directory, "spool");
    await import("node:fs/promises").then(fs => fs.mkdir(spoolRoot, { mode: 0o770 }));
    executable = join(directory, "converter");
    await writeFile(executable, "approved-converter");
    await chmod(executable, 0o555);
    digest = createHash("sha256").update("approved-converter").digest("hex");
  });

  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("fails closed before accepting a job when sidecar readiness is missing or has a different digest", async () => {
    const inputPath = join(directory, "source.dwg");
    const outputPath = join(directory, "converted.dxf");
    await writeFile(inputPath, "source");
    const converter = new SpoolCadConverter({ spoolRoot, approvedDigest: digest, timeoutMs: 100, maxOutputBytes: 1024 });

    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/sidecar.*ready/i);
    await writeFile(join(spoolRoot, ".ready.json"), JSON.stringify({
      version: 2,
      digest: "0".repeat(64),
      instanceId: "wrong-digest-sidecar",
      heartbeatAt: Date.now()
    }));
    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/digest|ready/i);
    expect((await readdir(spoolRoot)).filter(name => name.startsWith("job-"))).toHaveLength(0);
  });

  it("rejects a stale sidecar heartbeat even when its approved digest matches", async () => {
    const inputPath = join(directory, "source.dwg");
    const outputPath = join(directory, "converted.dxf");
    await writeFile(inputPath, "source");
    await writeFile(join(spoolRoot, ".ready.json"), JSON.stringify({
      version: 2,
      digest,
      instanceId: "stopped-sidecar",
      heartbeatAt: Date.now() - 10_000
    }));
    const converter = new SpoolCadConverter({ spoolRoot, approvedDigest: digest, timeoutMs: 100, maxOutputBytes: 1024 });

    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/sidecar.*ready|heartbeat|stale/i);
    expect((await readdir(spoolRoot)).filter(name => name.startsWith("job-"))).toHaveLength(0);
  });

  it("shares only a job-local spool and copies a bounded sidecar result to the API output", async () => {
    const inputPath = join(directory, "source.dwg");
    const outputPath = join(directory, "converted.dxf");
    await writeFile(inputPath, "source");
    await writeFile(join(spoolRoot, ".ready.json"), JSON.stringify({
      version: 2,
      digest,
      instanceId: "active-sidecar",
      heartbeatAt: Date.now()
    }));
    const converter = new SpoolCadConverter({ spoolRoot, approvedDigest: digest, timeoutMs: 2000, maxOutputBytes: 1024 });
    const serving = serveOne(spoolRoot, async jobDirectory => {
      const request = JSON.parse(await readFile(join(jobDirectory, "request.json"), "utf8"));
      expect(request).toEqual({ version: 1, input: "input", output: "output" });
      await processCadSidecarJob(jobDirectory, {
        approvedDigest: digest,
        executable,
        converter: { convert: async ({ inputPath: input, outputPath: output }) => {
          await writeFile(output, (await readFile(input, "utf8")) + "-converted");
          return { outputPath: output, outputBytes: 16 };
        } }
      });
    });

    await expect(converter.convert({ inputPath, outputPath })).resolves.toEqual({ outputPath, outputBytes: 16 });
    await serving;
    await expect(readFile(outputPath, "utf8")).resolves.toBe("source-converted");
  });

  it("attests a regular executable and rejects missing, writable, or replaced mounted files", async () => {
    await expect(attestCadConverterExecutable(executable, digest)).resolves.toMatchObject({ digest });
    await chmod(executable, 0o775);
    await expect(attestCadConverterExecutable(executable, digest)).rejects.toThrow(/mode|writable/i);
    await chmod(executable, 0o755);
    await writeFile(executable, "replacement");
    await chmod(executable, 0o555);
    await expect(attestCadConverterExecutable(executable, digest)).rejects.toThrow(/digest/i);
    await expect(attestCadConverterExecutable(join(directory, "missing"), digest)).rejects.toThrow(/attestation/i);
  });

  it("removes a previous instance heartbeat before startup attestation", async () => {
    const readyPath = join(spoolRoot, ".ready.json");
    await writeFile(readyPath, JSON.stringify({
      version: 2,
      digest: "0".repeat(64),
      instanceId: "previous-sidecar",
      heartbeatAt: Date.now()
    }));

    await expect(runCadConverterSidecar({
      CAD_IMPORT_CONVERTER_SPOOL_ROOT: spoolRoot,
      CAD_IMPORT_CONVERTER_EXECUTABLE: executable,
      CAD_IMPORT_CONVERTER_SHA256: "0".repeat(64),
      CAD_IMPORT_CONVERTER_ARGV_JSON: "[]"
    })).rejects.toThrow(/digest mismatch/i);
    await expect(readFile(readyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an aborted job directory until the sidecar can acknowledge cancellation", async () => {
    const inputPath = join(directory, "source.dwg");
    const outputPath = join(directory, "converted.dxf");
    await writeFile(inputPath, "source");
    await writeFile(join(spoolRoot, ".ready.json"), JSON.stringify({
      version: 2,
      digest,
      instanceId: "active-sidecar",
      heartbeatAt: Date.now()
    }));
    const abort = new AbortController();
    const converter = new SpoolCadConverter({ spoolRoot, approvedDigest: digest, timeoutMs: 1000, maxOutputBytes: 1024 });
    const serving = serveOne(spoolRoot, async jobDirectory => {
      abort.abort();
      await waitForFile(join(jobDirectory, "cancel"));
      await new Promise(resolve => setTimeout(resolve, 40));
      await writeFile(join(jobDirectory, "response.json"), JSON.stringify({
        version: 1,
        ok: false,
        error: "CAD conversion aborted"
      }));
    });

    await expect(converter.convert({ inputPath, outputPath, abortSignal: abort.signal })).rejects.toThrow(/aborted/i);
    await expect(serving).resolves.toBeUndefined();
  });

  it("hands off cancellation when readiness fails after the sidecar has claimed a job", async () => {
    const inputPath = join(directory, "source.dwg");
    const outputPath = join(directory, "converted.dxf");
    const readyPath = join(spoolRoot, ".ready.json");
    await writeFile(inputPath, "source");
    await writeFile(readyPath, JSON.stringify({
      version: 2,
      digest,
      instanceId: "active-sidecar",
      heartbeatAt: Date.now()
    }));
    const converter = new SpoolCadConverter({ spoolRoot, approvedDigest: digest, timeoutMs: 1000, maxOutputBytes: 1024 });
    const serving = serveOne(spoolRoot, async jobDirectory => {
      await rm(readyPath);
      await waitForFile(join(jobDirectory, "cancel"));
      await writeFile(join(jobDirectory, "response.json"), JSON.stringify({
        version: 1,
        ok: false,
        error: "sidecar readiness lost"
      }));
    });

    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/sidecar.*ready/i);
    await expect(serving).resolves.toBeUndefined();
  });

  it("treats a cancelled job directory disappearing as job-local cleanup", async () => {
    const jobDirectory = join(spoolRoot, "job-cancelled");
    await mkdir(jobDirectory);
    await writeFile(join(jobDirectory, "request.json"), JSON.stringify({ version: 1, input: "input", output: "output" }));
    await writeFile(join(jobDirectory, "input"), "source");
    let finishConversion: (() => void) | undefined;
    const conversionCanFinish = new Promise<void>(resolve => { finishConversion = resolve; });
    const processing = processCadSidecarJob(jobDirectory, {
      approvedDigest: digest,
      executable,
      converter: {
        convert: async () => {
          await conversionCanFinish;
          throw new Error("CAD conversion aborted");
        }
      }
    });

    await rm(jobDirectory, { recursive: true, force: true });
    finishConversion?.();

    await expect(processing).resolves.toBeUndefined();
  });
});

async function serveOne(spoolRoot: string, run: (jobDirectory: string) => Promise<void>) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const job = (await readdir(spoolRoot)).find(name => name.startsWith("job-"));
    if (job) return run(join(spoolRoot, job));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("spool job was not submitted");
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`file did not appear: ${path}`);
}
