import { readFileSync } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const quoteFixtureArgument = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const writeExecutableFixture = async (name: string, body: string) => {
    const executable = join(directory, name);
    await writeFile(executable, "#!/bin/bash\n" + body + "\n");
    await chmod(executable, 0o755);
    return executable;
  };
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

  it("passes only the converter runtime allowlist and never API credentials", async () => {
    const script = join(directory, "env.cjs");
    const inputPath = join(directory, "input.dwg");
    const outputPath = join(directory, "output.dxf");
    await writeFile(script, "require('node:fs').writeFileSync(process.argv[3], JSON.stringify(process.env));");
    await writeFile(inputPath, "input");
    process.env.DATABASE_URL = "postgresql://credential";
    process.env.OBJECT_STORAGE_SECRET_KEY = "storage-credential";
    process.env.VAULT_TOKEN = "vault-credential";
    try {
      const converter = new ArgvCadConverter({
        executable: process.execPath, argv: [script, "{input}", "{output}"], timeoutMs: 1000, maxOutputBytes: 4096,
        execution: runtimeExecution
      });
      await converter.convert({ inputPath, outputPath });
      const childEnv = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, string>;
      expect(childEnv).toEqual(expect.objectContaining({ LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TMPDIR: directory }));
      expect(childEnv.PATH).toMatch(/\/usr\/bin/);
      expect(childEnv).not.toHaveProperty("DATABASE_URL");
      expect(childEnv).not.toHaveProperty("OBJECT_STORAGE_SECRET_KEY");
      expect(childEnv).not.toHaveProperty("VAULT_TOKEN");
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.OBJECT_STORAGE_SECRET_KEY;
      delete process.env.VAULT_TOKEN;
    }
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
    const writeAttempt = join(directory, "kernel-write-attempt");
    const inputPath = join(directory, "input.dwg");
    const outputPath = join(directory, "output.dxf");
    await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(writeAttempt)}, "attempted"); require("node:fs").writeFileSync(process.argv[3], Buffer.alloc(1024 * 1024));`);
    await writeFile(inputPath, "input");
    const converter = new ArgvCadConverter({
      executable: process.execPath,
      argv: [script, "{input}", "{output}"],
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      execution: { mode: "linux-resource-limited" }
    });

    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/output.*limit/i);
    await expect(readFile(writeAttempt, "utf8")).resolves.toBe("attempted");
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills the detached Unix process group so descendants cannot retain pipes or write later", async () => {
    const markerPath = join(directory, "descendant-marker");
    const readyPath = join(directory, "descendant-ready");
    const inputPath = join(directory, "input.dwg");
    const outputPath = join(directory, "output.dxf");
    // A descendant publishes its own ready PID before its delayed write. Node
    // startup, or macOS evaluation of a new shebang file, can consume the entire
    // 50ms deadline and otherwise make the group-kill assertion a false positive.
    // Linux uses Bash builtins; acknowledged macOS development uses its native
    // Perl interpreter (no new executable-script evaluation or external sleep).
    const script = join(directory, "descendant.pl");
    await writeFile(script, [
      "my ($ready, $marker) = @ARGV; my $pid = fork(); die 'fork failed' unless defined $pid;",
      "if ($pid == 0) { open(my $fh, '>', $ready) or die $!; print {$fh} $$; close($fh);",
      "select(undef, undef, undef, 0.3); open(my $out, '>', $marker) or die $!; print {$out} 'escaped'; exit 0; }",
      "while (1) {}"
    ].join("\n"));
    const executable = process.platform === "linux" ? await writeExecutableFixture("descendant-fixture", [
      `(`,
      `printf '%s' "$BASHPID" > ${quoteFixtureArgument(readyPath)}`,
      "start=${EPOCHREALTIME/./}",
      "while (( ${EPOCHREALTIME/./} - start < 300000 )); do :; done",
      `printf escaped > ${quoteFixtureArgument(markerPath)}`,
      ") &",
      "while :; do :; done"
    ].join("\n")) : "/usr/bin/perl";
    await writeFile(inputPath, "input");
    const argv = process.platform === "linux" ? ["{input}", "{output}"] : [script, readyPath, markerPath, "{input}", "{output}"];
    const converter = new ArgvCadConverter({ executable, argv, timeoutMs: 50, maxOutputBytes: 1024, execution: runtimeExecution });
    const startedAt = Date.now();

    let readyPid: number | undefined;
    let existedBeforeKill = false;
    const observer = setInterval(() => {
      try {
        const pid = Number(readFileSync(readyPath, "utf8"));
        process.kill(pid, 0);
        readyPid = pid; existedBeforeKill = true;
      } catch { /* Ready file may not exist yet; missing child must fail the assertion below. */ }
    }, 1);
    try {
      await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/time.*limit/i);
    } finally { clearInterval(observer); }
    expect(existedBeforeKill).toBe(true);
    expect(readyPid).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeLessThan(250);
    await delay(350);
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => process.kill(readyPid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("polls the output file during conversion, kills on overflow and removes the partial file", async () => {
    const inputPath = join(directory, "input.dwg");
    const outputPath = join(directory, "output.dxf");
    // A single-process double attempts the write immediately under the same
    // limits. Node startup must not turn this output-limit case into a timeout.
    const script = join(directory, "growing-output.cjs");
    await writeFile(script, "require('node:fs').writeFileSync(process.argv[3], Buffer.alloc(4096)); setTimeout(() => {}, 500);");
    const executable = process.platform === "linux"
      ? await writeExecutableFixture("growing-output-fixture", 'printf "%4096s" "" > "$2"\nwhile :; do :; done')
      : process.execPath;
    await writeFile(inputPath, "input");
    const argv = process.platform === "linux" ? ["{input}", "{output}"] : [script, "{input}", "{output}"];
    const converter = new ArgvCadConverter({ executable, argv, timeoutMs: 1000, maxOutputBytes: 32, execution: runtimeExecution });
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
      argv: [
        "--as=536870912:536870912", "--cpu=60:60", "--nofile=64:64", "--nproc=32:32", "--fsize=4096:4096",
        "--", "/opt/cad/bin/converter", "--input", "/tmp/in.dwg", "--output", "/tmp/out.dxf"
      ],
      pollOutput: false
    });
  });

  it("ignores caller attempts to replace GNU prlimit semantics", () => {
    const launch = buildCadConverterLaunch({
      executable: "/opt/cad/bin/converter", argv: ["{input}", "{output}"], timeoutMs: 1000, maxOutputBytes: 32,
      execution: { mode: "linux-resource-limited", limiterExecutable: "/usr/bin/env", limiterArgv: ["CAD_LIMIT={maxOutputBytes}"] }
    } as never, ["/tmp/in.dwg", "/tmp/out.dxf"], "linux", trustedPrlimit);

    expect(launch.executable).toBe("/usr/bin/prlimit");
    expect(launch.argv).toEqual(expect.arrayContaining(["--as=536870912:536870912", "--cpu=60:60", "--nofile=64:64", "--nproc=32:32", "--fsize=32:32"]));
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
