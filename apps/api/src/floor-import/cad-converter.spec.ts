import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ArgvCadConverter,
  assertSupportedCadConverterPlatform,
  buildCadConverterLaunch,
  type CadLimiterExecutableInspector
} from "./cad-converter";

describe("argv CAD converter adapter", () => {
  let directory: string;

  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "cad-converter-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
  const runtimeExecution = process.platform === "linux"
    ? { mode: "linux-resource-limited" } as const
    : { mode: "macos-development-polling", acknowledgeNonProductionRisk: true } as const;
  const trustedPrlimit: CadLimiterExecutableInspector = {
    inspect: () => ({ realPath: "/usr/bin/prlimit", regularFile: true, symbolicLink: false, uid: 0, mode: 0o100755 })
  };

  it("passes input and output as distinct argv entries without a shell", async () => {
    const script = join(directory, "copy.cjs");
    const inputPath = join(directory, "drawing with spaces.dwg");
    const outputPath = join(directory, "normalized output.dxf");
    await writeFile(script, "require('node:fs').copyFileSync(process.argv[2], process.argv[3]);");
    await writeFile(inputPath, "DXF-CONTENT");
    const converter = new ArgvCadConverter({
      executable: process.execPath, argv: [script, "{input}", "{output}"], timeoutMs: 1000, maxOutputBytes: 1024,
      execution: runtimeExecution
    });

    await expect(converter.convert({ inputPath, outputPath })).resolves.toEqual({ outputPath, outputBytes: 11 });
    await expect(readFile(outputPath, "utf8")).resolves.toBe("DXF-CONTENT");
  });

  it.each([
    { executable: "/bin/sh", argv: ["-c", "cp {input} {output}"] },
    { executable: process.execPath, argv: ["tool.cjs;rm", "{input}", "{output}"] },
    { executable: process.execPath, argv: ["tool.cjs", "$(cat {input})", "{output}"] }
  ])("rejects dangerous executable or argv configuration before launch", config => {
    expect(() => new ArgvCadConverter({ ...config, timeoutMs: 100, maxOutputBytes: 100, execution: runtimeExecution })).toThrow(/unsafe|shell/i);
  });

  it("kills a converter that exceeds its time limit", async () => {
    const script = join(directory, "sleep.cjs");
    const inputPath = join(directory, "input.dwg");
    const outputPath = join(directory, "output.dxf");
    await writeFile(script, "setTimeout(() => require('node:fs').writeFileSync(process.argv[3], 'late'), 60000);");
    await writeFile(inputPath, "input");
    const converter = new ArgvCadConverter({ executable: process.execPath, argv: [script, "{input}", "{output}"], timeoutMs: 20, maxOutputBytes: 1024, execution: runtimeExecution });

    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/time.*limit/i);
  });

  it("rejects an oversized converter output", async () => {
    const script = join(directory, "oversize.cjs");
    const inputPath = join(directory, "input.dwg");
    const outputPath = join(directory, "output.dxf");
    await writeFile(script, "require('node:fs').writeFileSync(process.argv[3], Buffer.alloc(33));");
    await writeFile(inputPath, "input");
    const converter = new ArgvCadConverter({ executable: process.execPath, argv: [script, "{input}", "{output}"], timeoutMs: 1000, maxOutputBytes: 32, execution: runtimeExecution });

    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/output.*limit/i);
  });

  (process.platform === "linux" ? it : it.skip)("uses GNU prlimit to stop an oversized write at the kernel boundary", async () => {
    const script = join(directory, "kernel-oversize.cjs");
    const inputPath = join(directory, "input.dwg");
    const outputPath = join(directory, "output.dxf");
    await writeFile(script, "require('node:fs').writeFileSync(process.argv[3], Buffer.alloc(1024 * 1024));");
    await writeFile(inputPath, "input");
    const converter = new ArgvCadConverter({
      executable: process.execPath,
      argv: [script, "{input}", "{output}"],
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      execution: { mode: "linux-resource-limited" }
    });

    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/output.*limit/i);
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills the detached Unix process group so descendants cannot retain pipes or write later", async () => {
    const markerPath = join(directory, "descendant-marker");
    const script = join(directory, "descendant.cjs");
    const inputPath = join(directory, "input.dwg");
    const outputPath = join(directory, "output.dxf");
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'escaped'), 300)`;
    await writeFile(script, `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 60000);`);
    await writeFile(inputPath, "input");
    const converter = new ArgvCadConverter({ executable: process.execPath, argv: [script, "{input}", "{output}"], timeoutMs: 50, maxOutputBytes: 1024, execution: runtimeExecution });
    const startedAt = Date.now();

    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/time.*limit/i);
    expect(Date.now() - startedAt).toBeLessThan(250);
    await delay(350);
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("polls the output file during conversion, kills on overflow and removes the partial file", async () => {
    const script = join(directory, "growing-output.cjs");
    const inputPath = join(directory, "input.dwg");
    const outputPath = join(directory, "output.dxf");
    await writeFile(script, "require('node:fs').writeFileSync(process.argv[3], Buffer.alloc(4096)); setTimeout(() => {}, 500);");
    await writeFile(inputPath, "input");
    const converter = new ArgvCadConverter({ executable: process.execPath, argv: [script, "{input}", "{output}"], timeoutMs: 1000, maxOutputBytes: 32, execution: runtimeExecution });
    const startedAt = Date.now();

    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/output.*limit/i);
    expect(Date.now() - startedAt).toBeLessThan(400);
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a partial output on nonzero converter exit", async () => {
    const script = join(directory, "partial-failure.cjs");
    const inputPath = join(directory, "input.dwg");
    const outputPath = join(directory, "output.dxf");
    await writeFile(script, "require('node:fs').writeFileSync(process.argv[3], 'partial'); process.exit(7);");
    await writeFile(inputPath, "input");
    const converter = new ArgvCadConverter({ executable: process.execPath, argv: [script, "{input}", "{output}"], timeoutMs: 1000, maxOutputBytes: 1024, execution: runtimeExecution });

    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/code 7/i);
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on Windows because this adapter requires Unix process groups", () => {
    expect(() => assertSupportedCadConverterPlatform("win32")).toThrow(/unsupported.*platform|unix/i);
  });

  it("fails closed when no explicit hard-limit or development execution policy is configured", () => {
    expect(() => new ArgvCadConverter({
      executable: process.execPath, argv: ["tool.cjs", "{input}", "{output}"], timeoutMs: 100, maxOutputBytes: 100
    })).toThrow(/execution.*policy|resource.*limit/i);
  });

  it("builds a production Linux limiter argv wrapper without a shell", () => {
    const launch = buildCadConverterLaunch({
      executable: "/opt/cad/bin/converter", argv: ["--input", "{input}", "--output", "{output}"], timeoutMs: 1000, maxOutputBytes: 4096,
      execution: { mode: "linux-resource-limited" }
    }, ["--input", "/tmp/in.dwg", "--output", "/tmp/out.dxf"], "linux", trustedPrlimit);

    expect(launch).toEqual({
      executable: "/usr/bin/prlimit",
      argv: ["--fsize=4096:4096", "--", "/opt/cad/bin/converter", "--input", "/tmp/in.dwg", "--output", "/tmp/out.dxf"],
      pollOutput: false
    });
  });

  it("ignores caller attempts to replace GNU prlimit semantics", () => {
    const launch = buildCadConverterLaunch({
      executable: "/opt/cad/bin/converter", argv: ["{input}", "{output}"], timeoutMs: 1000, maxOutputBytes: 32,
      execution: { mode: "linux-resource-limited", limiterExecutable: "/usr/bin/env", limiterArgv: ["CAD_LIMIT={maxOutputBytes}"] }
    } as never, ["/tmp/in.dwg", "/tmp/out.dxf"], "linux", trustedPrlimit);

    expect(launch.executable).toBe("/usr/bin/prlimit");
    expect(launch.argv.slice(0, 2)).toEqual(["--fsize=32:32", "--"]);
  });

  it.each([
    ["non-canonical path", { realPath: "/opt/bin/prlimit", regularFile: true, symbolicLink: false, uid: 0, mode: 0o100755 }],
    ["symlink", { realPath: "/usr/bin/prlimit", regularFile: true, symbolicLink: true, uid: 0, mode: 0o120777 }],
    ["non-regular file", { realPath: "/usr/bin/prlimit", regularFile: false, symbolicLink: false, uid: 0, mode: 0o040755 }],
    ["non-root owner", { realPath: "/usr/bin/prlimit", regularFile: true, symbolicLink: false, uid: 501, mode: 0o100755 }],
    ["group writable", { realPath: "/usr/bin/prlimit", regularFile: true, symbolicLink: false, uid: 0, mode: 0o100775 }],
    ["not executable", { realPath: "/usr/bin/prlimit", regularFile: true, symbolicLink: false, uid: 0, mode: 0o100644 }]
  ])("rejects an unattested GNU prlimit identity: %s", (_label, identity) => {
    const inspector: CadLimiterExecutableInspector = { inspect: () => identity };
    expect(() => buildCadConverterLaunch({
      executable: "/opt/cad/bin/converter", argv: ["{input}", "{output}"], timeoutMs: 1000, maxOutputBytes: 4096,
      execution: { mode: "linux-resource-limited" }
    }, [], "linux", inspector)).toThrow(/prlimit.*identity|trusted.*prlimit|attestation/i);
  });
});
