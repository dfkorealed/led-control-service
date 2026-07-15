import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
