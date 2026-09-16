import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArgvCadConverter } from "./cad-converter";

describe("argv CAD converter adapter", () => {
  let directory: string;

  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "cad-converter-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("passes input and output as distinct argv entries without a shell", async () => {
    const script = join(directory, "copy.cjs");
    const inputPath = join(directory, "drawing with spaces.dwg");
    const outputPath = join(directory, "normalized output.dxf");
    await writeFile(script, "require('node:fs').copyFileSync(process.argv[2], process.argv[3]);");
    await writeFile(inputPath, "DXF-CONTENT");
    const converter = new ArgvCadConverter({
      executable: process.execPath, argv: [script, "{input}", "{output}"], timeoutMs: 1000, maxOutputBytes: 1024
    });

    await expect(converter.convert({ inputPath, outputPath })).resolves.toEqual({ outputPath, outputBytes: 11 });
    await expect(readFile(outputPath, "utf8")).resolves.toBe("DXF-CONTENT");
  });

  it.each([
    { executable: "/bin/sh", argv: ["-c", "cp {input} {output}"] },
    { executable: process.execPath, argv: ["tool.cjs;rm", "{input}", "{output}"] },
    { executable: process.execPath, argv: ["tool.cjs", "$(cat {input})", "{output}"] }
  ])("rejects dangerous executable or argv configuration before launch", config => {
    expect(() => new ArgvCadConverter({ ...config, timeoutMs: 100, maxOutputBytes: 100 })).toThrow(/unsafe|shell/i);
  });

  it("kills a converter that exceeds its time limit", async () => {
    const script = join(directory, "sleep.cjs");
    const inputPath = join(directory, "input.dwg");
    const outputPath = join(directory, "output.dxf");
    await writeFile(script, "setTimeout(() => require('node:fs').writeFileSync(process.argv[3], 'late'), 60000);");
    await writeFile(inputPath, "input");
    const converter = new ArgvCadConverter({ executable: process.execPath, argv: [script, "{input}", "{output}"], timeoutMs: 20, maxOutputBytes: 1024 });

    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/time.*limit/i);
  });

  it("rejects an oversized converter output", async () => {
    const script = join(directory, "oversize.cjs");
    const inputPath = join(directory, "input.dwg");
    const outputPath = join(directory, "output.dxf");
    await writeFile(script, "require('node:fs').writeFileSync(process.argv[3], Buffer.alloc(33));");
    await writeFile(inputPath, "input");
    const converter = new ArgvCadConverter({ executable: process.execPath, argv: [script, "{input}", "{output}"], timeoutMs: 1000, maxOutputBytes: 32 });

    await expect(converter.convert({ inputPath, outputPath })).rejects.toThrow(/output.*limit/i);
  });
});
