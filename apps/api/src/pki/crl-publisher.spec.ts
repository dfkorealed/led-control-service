import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestCrl } from "./crl.test-support";
import { publishCrlAtomically } from "./crl-publisher";

const CRL = "-----BEGIN X509 CRL-----\nMIIB\n-----END X509 CRL-----\n";

describe("publishCrlAtomically", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "crl-publisher-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes a valid PEM CRL with a stable mode then no-ops for the same checksum", async () => {
    const path = join(directory, "device.crl.pem");

    await expect(publishCrlAtomically(path, CRL)).resolves.toEqual({ changed: true });
    await expect(readFile(path, "utf8")).resolves.toBe(CRL);
    await expect(stat(path)).resolves.toMatchObject({ mode: expect.any(Number) });
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await expect(publishCrlAtomically(path, CRL)).resolves.toEqual({ changed: false });
  });

  it("rejects non-PEM CRL content without creating a destination file", async () => {
    const path = join(directory, "device.crl.pem");

    await expect(publishCrlAtomically(path, "SECRET-CRL")).rejects.toThrow("CRL must be PEM encoded");
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("atomically replaces the intermediate while preserving exactly one existing Root CRL", async () => {
    const path = join(directory, "device.crl.pem");
    const staleIntermediate = await createTestCrl(["AA01"], "CN=Device Intermediate", 0);
    const refreshedIntermediate = await createTestCrl(["AA01", "BB02"], "CN=Device Intermediate", 1);
    const root = await createTestCrl([], "CN=Lab Root", 0);
    await writeFile(path, `${staleIntermediate.trim()}\n${root.trim()}\n`, { mode: 0o644 });

    await publishCrlAtomically(path, refreshedIntermediate);

    const published = await readFile(path, "utf8");
    expect(published.match(/-----BEGIN X509 CRL-----/g)).toHaveLength(2);
    expect(published).toBe(`${refreshedIntermediate.trim()}\n${root.trim()}\n`);
  });
});
