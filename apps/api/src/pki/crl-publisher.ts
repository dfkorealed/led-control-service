import { createHash, randomBytes } from "node:crypto";
import { chmod, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

const CRL_PEM_PATTERN = /^-----BEGIN X509 CRL-----\r?\n[\s\S]+-----END X509 CRL-----\r?\n?$/;

export async function publishCrlAtomically(destination: string, pem: string) {
  if (typeof pem !== "string" || !CRL_PEM_PATTERN.test(pem)) throw new Error("CRL must be PEM encoded");
  const checksum = checksumOf(pem);
  try {
    const existing = await readFile(destination, "utf8");
    if (checksumOf(existing) === checksum) return { changed: false as const };
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw new Error("CRL destination is not readable");
  }

  const temporary = `${destination}.${randomBytes(12).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(pem, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await chmod(destination, 0o644);

  const directory = await open(dirname(destination), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return { changed: true as const };
}

function checksumOf(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
