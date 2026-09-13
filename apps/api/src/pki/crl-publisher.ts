import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import { chmod, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { X509Crl } from "@peculiar/x509";

const CRL_PEM_PATTERN = /^-----BEGIN X509 CRL-----\r?\n[\s\S]+-----END X509 CRL-----\r?\n?$/;
const CRL_PEM_BLOCK_PATTERN = /-----BEGIN X509 CRL-----[\s\S]*?-----END X509 CRL-----/g;

export async function publishCrlAtomically(destination: string, pem: string, trustedRootCrlPem: string) {
  if (typeof pem !== "string" || !CRL_PEM_PATTERN.test(pem)) throw new Error("CRL must be PEM encoded");
  if (!trustedRootCrlPem) throw new Error("trusted Root CRL is required");
  const trustedRoot = trustedRootCrlFromBundle(trustedRootCrlPem);
  let output: string;
  try {
    const existing = await readFile(destination, "utf8");
    output = mergeWithExistingRootCrl(normalizePem(pem), existing, trustedRoot);
    if (checksumOf(existing) === checksumOf(output)) return { changed: false as const };
  } catch (error: any) {
    throw new Error(error?.code === "ENOENT" ? "CRL destination is missing its Root CRL" : "CRL destination is not readable");
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
  const expected = normalizeExpectedSerial(certificateSerial);
  // X.509 serials are ASN.1 INTEGER values. Compare their canonical numeric
  // hexadecimal form so an encoding-only leading 00 cannot evade or falsely
  // fail the exact revoked-certificate check.
  const contains = blocks[0].crl.entries.some(entry => normalizeDerSerial(entry.serialNumber) === expected);
  if (!contains) throw new Error("CA CRL snapshot does not contain the revoked certificate");
}

export function trustedRootCrlFromBundle(source: string) {
  const blocks = parseCrlBlocks(source);
  if (blocks.length > 2) throw new Error("trusted CRL input contains additional CRLs");
  const root = blocks.at(-1)!;
  if (blocks.length === 2 && blocks[0].crl.issuer === root.crl.issuer) {
    throw new Error("trusted CRL bundle does not identify a distinct Root");
  }
  return `${root.pem}\n`;
}

function mergeWithExistingRootCrl(intermediatePem: string, existingPem: string, trustedRootPem: string) {
  const [intermediate] = parseCrlBlocks(intermediatePem);
  const existing = parseCrlBlocks(existingPem);
  const [trustedRoot] = parseCrlBlocks(trustedRootPem);
  if (existing.length !== 2) throw new Error("runtime CRL bundle must contain exactly intermediate and Root CRLs");
  if (existing[0].crl.issuer !== intermediate.crl.issuer) throw new Error("runtime intermediate CRL issuer changed");
  if (existing[1].pem !== trustedRoot.pem || trustedRoot.crl.issuer === intermediate.crl.issuer) {
    throw new Error("runtime Root CRL does not match the configured trust input");
  }
  // Bootstrap installs intermediate+Root. Vault only returns the intermediate
  // CRL, so replacing the whole file would silently drop Root revocations.
  // Replace same-issuer snapshots and retain the one different-issuer Root CRL.
  return `${intermediate.pem}\n${trustedRoot.pem}\n`;
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

function normalizeExpectedSerial(value: string) {
  const compact = value.replace(/[:-]/g, "").trim().toUpperCase();
  if (!compact || compact.length % 2 !== 0 || !/^[0-9A-F]+$/.test(compact)) throw new Error("certificate serial is invalid");
  if (compact === "00" || compact.startsWith("0000")) throw new Error("certificate serial is not minimally encoded");
  if (compact.startsWith("00")) {
    if (Number.parseInt(compact.slice(2, 4), 16) < 0x80) throw new Error("certificate serial is not minimally encoded");
    return compact.slice(2);
  }
  if (compact.length / 2 > 20) throw new Error("certificate serial is too long");
  return compact;
}

function normalizeDerSerial(value: string) {
  const compact = value.replace(/[:-]/g, "").trim().toUpperCase();
  if (!compact || compact.length % 2 !== 0 || !/^[0-9A-F]+$/.test(compact)) throw new Error("CRL serial is invalid");
  const first = Number.parseInt(compact.slice(0, 2), 16);
  if (first === 0) {
    if (compact.length === 2 || Number.parseInt(compact.slice(2, 4), 16) < 0x80) {
      throw new Error("CRL serial is not a minimally encoded positive INTEGER");
    }
    const canonical = compact.slice(2);
    if (canonical.length / 2 > 20) throw new Error("CRL serial is too long");
    return canonical;
  }
  if (first >= 0x80) throw new Error("CRL serial is a negative INTEGER");
  if (compact.length / 2 > 20) throw new Error("CRL serial is too long");
  return compact;
}

function normalizePem(pem: string) {
  return `${pem.trim()}\n`;
}

function checksumOf(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
