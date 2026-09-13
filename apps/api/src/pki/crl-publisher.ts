import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import { chmod, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { X509Crl } from "@peculiar/x509";

const CRL_PEM_PATTERN = /^-----BEGIN X509 CRL-----\r?\n[\s\S]+-----END X509 CRL-----\r?\n?$/;
const CRL_PEM_BLOCK_PATTERN = /-----BEGIN X509 CRL-----[\s\S]*?-----END X509 CRL-----/g;

export async function publishCrlAtomically(destination: string, pem: string) {
  if (typeof pem !== "string" || !CRL_PEM_PATTERN.test(pem)) throw new Error("CRL must be PEM encoded");
  let output = normalizePem(pem);
  try {
    const existing = await readFile(destination, "utf8");
    if (checksumOf(existing) === checksumOf(output)) return { changed: false as const };
    output = mergeWithExistingRootCrl(output, existing);
    if (checksumOf(existing) === checksumOf(output)) return { changed: false as const };
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw new Error("CRL destination is not readable");
  }

  const temporary = `${destination}.${randomBytes(12).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(output, "utf8");
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

export function assertCrlContainsSerial(pem: string, certificateSerial: string) {
  const blocks = parseCrlBlocks(pem);
  if (blocks.length !== 1) throw new Error("CA CRL snapshot must contain exactly one CRL");
  const expected = normalizeSerial(certificateSerial);
  // X.509 serials are ASN.1 INTEGER values. Compare their canonical numeric
  // hexadecimal form so an encoding-only leading 00 cannot evade or falsely
  // fail the exact revoked-certificate check.
  const contains = blocks[0].crl.entries.some(entry => normalizeSerial(entry.serialNumber) === expected);
  if (!contains) throw new Error("CA CRL snapshot does not contain the revoked certificate");
}

function mergeWithExistingRootCrl(intermediatePem: string, existingPem: string) {
  const [intermediate] = parseCrlBlocks(intermediatePem);
  const existing = parseCrlBlocks(existingPem);
  const retained = existing.filter(block => block.crl.issuer !== intermediate.crl.issuer);
  if (retained.length > 1) throw new Error("CRL destination contains an ambiguous CA bundle");
  // Bootstrap installs intermediate+Root. Vault only returns the intermediate
  // CRL, so replacing the whole file would silently drop Root revocations.
  // Replace same-issuer snapshots and retain the one different-issuer Root CRL.
  return [intermediate.pem, ...retained.map(block => block.pem)].join("\n") + "\n";
}

function parseCrlBlocks(source: string) {
  const matches = [...source.matchAll(CRL_PEM_BLOCK_PATTERN)];
  if (!matches.length) throw new Error("CRL PEM block is required");
  let offset = 0;
  const blocks = matches.map(match => {
    const start = match.index ?? 0;
    if (source.slice(offset, start).trim()) throw new Error("CRL PEM bundle is invalid");
    offset = start + match[0].length;
    const pem = match[0].trim();
    return { pem, crl: new X509Crl(pem) };
  });
  if (source.slice(offset).trim()) throw new Error("CRL PEM bundle is invalid");
  return blocks;
}

function normalizeSerial(value: string) {
  const compact = value.replace(/[:-]/g, "").trim().toUpperCase();
  if (!compact || !/^[0-9A-F]+$/.test(compact)) throw new Error("certificate serial is invalid");
  return compact.replace(/^0+(?=[0-9A-F])/, "");
}

function normalizePem(pem: string) {
  return `${pem.trim()}\n`;
}

function checksumOf(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
