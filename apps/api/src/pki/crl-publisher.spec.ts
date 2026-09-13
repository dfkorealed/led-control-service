import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestCrl } from "./crl.test-support";
import { assertCrlContainsSerial, publishCrlAtomically } from "./crl-publisher";

describe("publishCrlAtomically", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "crl-publisher-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("atomically writes a trusted two-CRL bundle with a stable mode then no-ops", async () => {
    const path = join(directory, "device.crl.pem");
    const intermediate = await createTestCrl(["0102"], "CN=Device Intermediate", 0);
    const root = await createTestCrl([], "CN=Lab Root", 0);
    const bundle = `${intermediate.trim()}\n${root.trim()}\n`;
    await writeFile(path, bundle, { mode: 0o644 });

    await expect(publishCrlAtomically(path, intermediate, root)).resolves.toEqual({ changed: false });
    await expect(readFile(path, "utf8")).resolves.toBe(bundle);
    await expect(stat(path)).resolves.toMatchObject({ mode: expect.any(Number) });
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  it("rejects non-PEM CRL content without creating a destination file", async () => {
    const path = join(directory, "device.crl.pem");

    await expect(publishCrlAtomically(path, "SECRET-CRL", "unused-invalid-root")).rejects.toThrow("CRL must be PEM encoded");
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("atomically replaces the intermediate while preserving exactly one existing Root CRL", async () => {
    const path = join(directory, "device.crl.pem");
    const staleIntermediate = await createTestCrl(["AA01"], "CN=Device Intermediate", 0);
    const refreshedIntermediate = await createTestCrl(["AA01", "BB02"], "CN=Device Intermediate", 1);
    const root = await createTestCrl([], "CN=Lab Root", 0);
    await writeFile(path, `${staleIntermediate.trim()}\n${root.trim()}\n`, { mode: 0o644 });

    await (publishCrlAtomically as any)(path, refreshedIntermediate, root);

    const published = await readFile(path, "utf8");
    expect(published.match(/-----BEGIN X509 CRL-----/g)).toHaveLength(2);
    expect(published).toBe(`${refreshedIntermediate.trim()}\n${root.trim()}\n`);
  });

  it.each([
    ["missing Root", async (stale: string) => stale],
    ["untrusted Root", async (stale: string) => `${stale.trim()}\n${await createTestCrl([], "CN=Untrusted Root", 0)}`],
    ["additional CRL", async (stale: string) => `${stale.trim()}\n${await createTestCrl([], "CN=Untrusted Root", 0)}\n${await createTestCrl([], "CN=Lab Root", 0)}`]
  ])("rejects a runtime bundle with %s instead of selecting an arbitrary issuer", async (_label, existing) => {
    const path = join(directory, "device.crl.pem");
    const staleIntermediate = await createTestCrl(["AA01"], "CN=Device Intermediate", 0);
    const refreshedIntermediate = await createTestCrl(["AA01", "BB02"], "CN=Device Intermediate", 1);
    const trustedRoot = await createTestCrl([], "CN=Lab Root", 0);
    const original = `${(await existing(staleIntermediate)).trim()}\n`;
    await writeFile(path, original, { mode: 0o644 });

    await expect((publishCrlAtomically as any)(path, refreshedIntermediate, trustedRoot)).rejects.toThrow();
    await expect(readFile(path, "utf8")).resolves.toBe(original);
  });

  it("rejects publication without an explicit trusted Root CRL", async () => {
    const path = join(directory, "device.crl.pem");
    const intermediate = await createTestCrl(["AA01"], "CN=Device Intermediate", 0);
    const root = await createTestCrl([], "CN=Lab Root", 0);
    await writeFile(path, `${intermediate.trim()}\n${root.trim()}\n`, { mode: 0o644 });

    await expect(publishCrlAtomically(path, intermediate, undefined as unknown as string)).rejects.toThrow();
  });

  it("matches a valid positive serial but rejects negative and non-minimal ASN.1 INTEGER encodings", async () => {
    const positive = await createTestCrl(["AA01"], "CN=Device Intermediate", 0);
    const negative = await createTestCrl(["AA01"], "CN=Device Intermediate", 1, false);
    const nonMinimal = await createTestCrl(["0000AA01"], "CN=Device Intermediate", 2, false);

    expect(() => assertCrlContainsSerial(positive, "AA01")).not.toThrow();
    expect(() => assertCrlContainsSerial(negative, "AA01")).toThrow();
    expect(() => assertCrlContainsSerial(nonMinimal, "AA01")).toThrow();
    expect(() => assertCrlContainsSerial(positive, "0000AA01")).toThrow();
  });

  it.each([
    ["negative", ["0102", "AA01"]],
    ["non-minimal", ["0102", "00000102"]]
  ])("rejects a later %s revoked serial even after an earlier valid match", async (_label, serials) => {
    const crl = await createTestCrl(serials, "CN=Device Intermediate", 0, false);

    expect(() => assertCrlContainsSerial(crl, "0102")).toThrow();
  });
});
