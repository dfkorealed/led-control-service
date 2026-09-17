import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpoolCadConverter } from "./cad-converter-spool";
import { attestCadConverterExecutable, processCadSidecarJob } from "./cad-converter-sidecar";

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
    await writeFile(join(spoolRoot, ".ready.json"), JSON.stringify({ version: 1, digest: "0".repeat(64) }));
    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/digest|ready/i);
    expect((await readdir(spoolRoot)).filter(name => name.startsWith("job-"))).toHaveLength(0);
  });

  it("shares only a job-local spool and copies a bounded sidecar result to the API output", async () => {
    const inputPath = join(directory, "source.dwg");
    const outputPath = join(directory, "converted.dxf");
    await writeFile(inputPath, "source");
    await writeFile(join(spoolRoot, ".ready.json"), JSON.stringify({ version: 1, digest }));
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
