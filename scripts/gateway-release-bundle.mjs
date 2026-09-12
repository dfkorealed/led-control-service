#!/usr/bin/env node
// Build/CI tooling only. The Pi release manager consumes checksum-protected,
// allowlisted appliance.env; it must not assume Node is installed on the host.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip, createInflateRaw } from "node:zlib";

const repository = path.resolve(import.meta.dirname, "..");
const inventoryPath = "usr/local/share/gateway-release-inventory.json";
const checksumFile = "checksums.sha256";
const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
const maxLayerBytes = 512 * 1024 * 1024;
const maxImageBytes = 2 * 1024 * 1024 * 1024;
// Count all nonzero headers, including metadata and repeated/zero-byte paths,
// before allocating entry records. Byte limits alone cannot bound tar arrays.
const maxOuterEntries = 4096, maxLayerEntries = 100000, maxImageEntries = 250000;
const privateMaterialScan = {
  profile: "led-control-private-material/v3",
  scope: "bundle-regular-files-and-each-image-layer-regular-file-including-deleted",
  filenames: "site-env-known-private-basenames-directories-and-key-container-extensions",
  pem: "complete-node-crypto-private-key-blocks-in-utf8-text",
  der: "standalone-node-crypto-pkcs1-pkcs8-sec1-with-ascii-whitespace",
  encrypted: "complete-encrypted-private-key-pem-or-standalone-strict-pkcs8-encrypted-private-key-info-der",
  base64: "entire-file-one-standard-base64-layer-with-ascii-whitespace",
  maxDerBytes: 65536,
  maxPemBlockChars: 131072,
  maxBase64CandidateChars: 131072,
  notCovered: ["general-secrets", "embedded-binary-der", "embedded-base64-tokens", "oversized-candidates", "nested-decompression", "other-encodings-or-obfuscation"],
};
const fail = (message) => { throw new Error(message); };
const requireValue = (condition, message) => { if (!condition) fail(message); };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const canonicalJson = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item, 2) + "\n";
const compactJson = (value) => JSON.stringify(JSON.parse(canonicalJson(value)));
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);

function keys(value, expected, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value)
    && equal(Object.keys(value).sort(), expected.split(" ").sort()), `${label}: invalid fields`);
}

function safePath(value, label = "path") {
  requireValue(typeof value === "string" && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)
    && value.split("/").every((part) => part !== "." && part !== ".."), `unsafe ${label}`);
  return value;
}

function rejectSecretName(value) {
  const filename = value.split("/").at(-1);
  requireValue(!/^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(filename)
    && !/\.(?:key|p12|pfx|pkcs12|pkcs8)$/i.test(filename)
    // "key" also names public tools/modules (apt-key, key.js). Only known
    // private basenames/directories are name-denied; extensionless key files
    // and public-vs-private PEM are decided by the file-content profile.
    && !value.split("/").some(part => /(?:^|[-_.])private[-_.]?keys?(?:$|[-_.])/i.test(part)), `secret filename is forbidden: ${value}`);
}

function parseJson(text) {
  let value;
  try { value = JSON.parse(text); } catch { fail("invalid JSON input"); }
  // Docker JSON is not canonical, so a second token walk detects duplicate
  // keys without requiring Docker's serializer to use our formatting. Never
  // expose SyntaxError's excerpt: malformed inputs may contain secrets.
  const tokens = /\s*("(?:\\.|[^"\\])*"|[{}\[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/gy;
  const next = () => tokens.exec(text)?.[1];
  function visit(token, depth = 0) {
    requireValue(depth < 128, "JSON nesting limit exceeded");
    if (token === "{") {
      const seen = new Set();
      let key = next();
      if (key === "}") return;
      for (;;) {
        const decoded = JSON.parse(key);
        requireValue(!seen.has(decoded), "duplicate JSON key");
        seen.add(decoded);
        requireValue(next() === ":", "invalid JSON object");
        visit(next(), depth + 1);
        const separator = next();
        if (separator === "}") return;
        requireValue(separator === ",", "invalid JSON object");
        key = next();
      }
    } else if (token === "[") {
      let child = next();
      if (child === "]") return;
      for (;;) {
        visit(child, depth + 1);
        const separator = next();
        if (separator === "]") return;
        requireValue(separator === ",", "invalid JSON array");
        child = next();
      }
    }
  }
  visit(next());
  return value;
}

async function regularFile(filename) {
  const status = await lstat(filename);
  requireValue(status.isFile() && status.nlink === 1, `expected a non-linked regular file: ${path.basename(filename)}`);
  return status;
}

async function readJson(filename, canonical = false) {
  const status = await regularFile(filename);
  requireValue(status.size <= 16 * 1024 * 1024, "JSON input exceeds size limit");
  const text = await readFile(filename, "utf8");
  const value = parseJson(text);
  // Exact canonical bytes reject duplicate object keys, trailing data and
  // alternate encodings instead of letting JSON.parse silently choose a key.
  requireValue(!canonical || text === canonicalJson(value), "expected canonical JSON (no duplicate keys)");
  return value;
}

function derSequence(bytes, offset) {
  if (bytes[offset] !== 0x30 || offset + 2 > bytes.length) return undefined;
  const first = bytes[offset + 1];
  const count = first & 0x7f;
  if (first < 0x80) return { body: offset + 2, end: offset + 2 + first };
  if (count === 0 || count > 4 || offset + 2 + count > bytes.length || bytes[offset + 2] === 0) return undefined;
  const length = bytes.readUIntBE(offset + 2, count);
  if (length < 128) return undefined;
  return { body: offset + 2 + count, end: offset + 2 + count + length };
}

const asciiWhitespace = byte => byte === 32 || (byte >= 9 && byte <= 13);
function parsesPrivateKey(options) {
  try { return createPrivateKey(options).type === "private"; } catch { return false; }
}
function encryptedPrivateKeyInfo(bytes) {
  // EncryptedPrivateKeyInfo ::= SEQUENCE { AlgorithmIdentifier, OCTET STRING }.
  // Decryption is neither possible nor necessary: reject this bounded exact
  // structural container, without claiming to authenticate its ciphertext.
  let nodes = 0;
  function element(offset, end, depth = 0) {
    if (++nodes > 128 || depth > 12 || offset + 2 > end) return undefined;
    const tag = bytes[offset], first = bytes[offset + 1], count = first & 0x7f;
    if (tag === 0 || (tag & 31) === 31 || (first >= 128 && (count === 0 || count > 4 || offset + 2 + count > end || bytes[offset + 2] === 0))) return undefined;
    const length = first < 128 ? first : bytes.readUIntBE(offset + 2, count);
    const body = offset + 2 + (first < 128 ? 0 : count), stop = body + length;
    if ((first >= 128 && length < 128) || stop > end) return undefined;
    if (tag & 32) {
      for (let cursor = body; cursor < stop;) { const child = element(cursor, stop, depth + 1); if (!child) return undefined; cursor = child.end; }
    } else if (tag === 6) {
      if (!length || (bytes[stop - 1] & 128)) return undefined;
      for (let cursor = body; cursor < stop; cursor++) if (bytes[cursor] === 128 && (cursor === body || !(bytes[cursor - 1] & 128))) return undefined;
    } else if (tag === 2 && (!length || (length > 1 && ((bytes[body] === 0 && !(bytes[body + 1] & 128)) || (bytes[body] === 255 && (bytes[body + 1] & 128)))))) return undefined;
    else if (tag === 5 && length !== 0) return undefined;
    return { tag, body, end: stop };
  }
  const outer = element(0, bytes.length);
  if (outer?.tag !== 0x30 || outer.end !== bytes.length) return false;
  const algorithm = element(outer.body, outer.end);
  if (algorithm?.tag !== 0x30) return false;
  const oid = element(algorithm.body, algorithm.end);
  if (oid?.tag !== 6) return false;
  if (oid.end !== algorithm.end && element(oid.end, algorithm.end)?.end !== algorithm.end) return false;
  const ciphertext = element(algorithm.end, outer.end);
  return ciphertext?.tag === 4 && ciphertext.body < ciphertext.end && ciphertext.end === outer.end;
}
function standalonePrivateDer(bytes) {
  let start = 0;
  while (start < bytes.length && asciiWhitespace(bytes[start])) start++;
  const sequence = derSequence(bytes, start);
  if (!sequence || sequence.end - start > privateMaterialScan.maxDerBytes || sequence.end > bytes.length
    || !bytes.subarray(sequence.end).every(asciiWhitespace)) return false;
  const key = bytes.subarray(start, sequence.end);
  return encryptedPrivateKeyInfo(key) || ["pkcs1", "pkcs8", "sec1"].some(type => parsesPrivateKey({ key, format: "der", type }));
}
function completePrivatePem(text, standalone = false) {
  for (const match of text.matchAll(/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g)) {
    if (standalone && /[^\x09-\x0d ]/.test(text.slice(0, match.index) + text.slice(match.index + match[0].length))) continue;
    if (match[0].length <= privateMaterialScan.maxPemBlockChars && (match[1] === "ENCRYPTED PRIVATE KEY" || parsesPrivateKey(match[0]))) return true;
  }
  return false;
}
function privateFileScanner() {
  // A key artifact is a regular file, not arbitrary offsets in ELF libraries
  // or tar headers/padding. Bounded candidates span chunks but never files.
  // Defer PEM rejection until EOF confirms the entire file is UTF-8 text.
  let der = Buffer.alloc(0), derStarted = false, derRestWhitespace = true;
  let encoded = "", base64 = true, text = true, pem = "", foundPem = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    update(chunk) {
      if (derRestWhitespace) {
        let start = 0;
        if (!derStarted) while (start < chunk.length && asciiWhitespace(chunk[start])) start++;
        if (start < chunk.length) {
          derStarted = true;
          const take = Math.min(privateMaterialScan.maxDerBytes - der.length, chunk.length - start);
          der = Buffer.concat([der, chunk.subarray(start, start + take)]);
          derRestWhitespace = chunk.subarray(start + take).every(asciiWhitespace);
        }
      }
      if (base64) {
        const part = chunk.toString("latin1").replace(/[\x09-\x0d ]/g, "");
        base64 = /^[A-Za-z0-9+/=]*$/.test(part) && encoded.length + part.length <= privateMaterialScan.maxBase64CandidateChars;
        if (base64) encoded += part;
      }
      if (text) {
        text = !/[\x00-\x08\x0e-\x1f\x7f]/.test(chunk.toString("latin1"));
        try {
          const decoded = decoder.decode(chunk, { stream: true });
          if (text && !foundPem) {
            const combined = pem + decoded;
            foundPem = completePrivatePem(combined);
            pem = combined.slice(-privateMaterialScan.maxPemBlockChars);
          }
        } catch { text = false; }
      }
    },
    finish() {
      requireValue(!derRestWhitespace || !standalonePrivateDer(der), "private key material is forbidden (standalone DER)");
      if (text) { try { decoder.decode(); } catch { text = false; } }
      requireValue(!text || !foundPem, "private key material is forbidden (complete PEM)");
      if (base64 && encoded.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        const decoded = Buffer.from(encoded, "base64");
        if (decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) return;
        requireValue(!standalonePrivateDer(decoded) && !completePrivatePem(decoded.toString("utf8"), true), "private key material is forbidden (standalone base64)");
      }
    },
  };
}

async function digestRange(filename, start = 0, size, scanSecrets = true) {
  const hash = createHash("sha256");
  const scanner = scanSecrets ? privateFileScanner() : undefined;
  if (size === 0) return hash.digest("hex");
  for await (const chunk of createReadStream(filename, { start, ...(size === undefined ? {} : { end: start + size - 1 }) })) {
    hash.update(chunk);
    scanner?.update(chunk);
  }
  scanner?.finish();
  return hash.digest("hex");
}

async function loadPolicy(filename) {
  const value = await readJson(filename, true);
  keys(value, "schema policyVersion source platform bluez firmwareCompatibility", "release policy");
  keys(value.bluez, "version sourceSha256", "BlueZ policy");
  keys(value.firmwareCompatibility, "productIdentityFormat dimmingCommandWire automationSnapshotSchema vehicleSensorProtocol espIdfVersion bluetoothCompanyId", "firmware policy");
  requireValue(value.schema === "led-control-gateway-release/v1" && value.policyVersion === 1 && value.platform === "linux/arm64", "unsupported release policy");
  requireValue(/^https:\/\/[A-Za-z0-9./_-]+$/.test(value.source) && sha256Pattern.test(value.bluez.sourceSha256), "invalid source policy");
  requireValue(typeof value.bluez.version === "string" && /^\d+\.\d+$/.test(value.bluez.version), "invalid BlueZ version");
  requireValue(equal(value.firmwareCompatibility, {
    productIdentityFormat: 1, dimmingCommandWire: 2, automationSnapshotSchema: 1, vehicleSensorProtocol: 1,
    espIdfVersion: "v5.5.1", bluetoothCompanyId: "runtime-must-match-signed-firmware",
  }), "unsupported firmware compatibility policy");
  return value;
}

export function imageLabels(manifest, policy) {
  return {
    "org.opencontainers.image.version": manifest.gatewayVersion,
    "org.opencontainers.image.revision": manifest.gitCommit,
    "org.opencontainers.image.created": manifest.gitCommitTimestamp,
    "org.opencontainers.image.source": policy.source,
    "com.led-control.lock-sha256": manifest.lockSha256,
    "com.led-control.release-policy-sha256": sha256(canonicalJson(policy)),
    "com.led-control.bluez.version": policy.bluez.version,
    "com.led-control.bluez.source-sha256": policy.bluez.sourceSha256,
    "com.led-control.firmware-compatibility": compactJson(policy.firmwareCompatibility),
    "com.led-control.release.test-mode": String(manifest.testMode),
  };
}

function validateInventory(value) {
  keys(value, "schema os node", "inventory");
  keys(value.os, "id version packages", "OS inventory");
  keys(value.node, "version packages", "Node inventory");
  requireValue(value.schema === "led-control-gateway-inventory/v1" && value.os.id === "debian" && value.os.version === "12", "unsupported OS inventory");
  requireValue(Array.isArray(value.os.packages) && value.os.packages.length > 0, "OS package inventory must not be empty");
  requireValue(/^22\./.test(value.node.version) && Array.isArray(value.node.packages) && value.node.packages.length > 0, "Node package inventory must not be empty and runtime must be Node 22");
  for (const [kind, packages] of [["os", value.os.packages], ["node", value.node.packages]]) {
    const seen = new Set();
    for (const item of packages) {
      keys(item, kind === "os" ? "name version architecture" : "name version location license", `${kind} package`);
      requireValue([item.name, item.version, kind === "os" ? item.architecture : item.location].every((part) => typeof part === "string" && part.length > 0 && !/[\x00-\x1f\x7f]/.test(part)), "invalid package inventory entry");
      const identity = kind === "os" ? `${item.name}:${item.architecture}` : item.location;
      requireValue(!seen.has(identity), "duplicate package inventory entry");
      seen.add(identity);
      if (kind === "node") {
        requireValue(typeof item.license === "string" && /^(?:node_modules|global_node_modules)\//.test(item.location)
          && !item.location.split("/").includes(".."), "invalid Node package location/license");
      }
    }
  }
  return value;
}

// Layers are raw tar after bounded transport decoding. Index bytes in-place: never
// extract an untrusted archive to disk or follow its paths/symlinks. OS layer
// symlinks are normal; release-directory symlinks are separately forbidden.
async function tarEntries(filename, start = 0, size, budget) {
  const handle = await open(filename, "r");
  const end = start + (size ?? (await handle.stat()).size);
  const entries = [];
  let offset = start;
  let extended = {};
  let longName;
  let count = 0;
  const read = async (position, length) => {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    requireValue(bytesRead === length, "truncated image tar");
    return buffer;
  };
  try {
    requireValue((end - start) % 512 === 0, "unsupported or truncated image tar (uncompressed docker save required)");
    while (offset + 512 <= end) {
      const header = await read(offset, 512);
      if (header.every((byte) => byte === 0)) {
        requireValue(offset + 1024 <= end, "truncated tar end marker");
        for (let position = offset; position < end; position += 64 * 1024) {
          requireValue((await read(position, Math.min(64 * 1024, end - position))).every((byte) => byte === 0), "extra data after tar end marker");
        }
        return entries;
      }
      requireValue(++count <= (budget ? maxLayerEntries : maxOuterEntries), `${budget ? "layer" : "outer"} tar entry limit exceeded`);
      if (budget) requireValue(++budget.count <= maxImageEntries, "cumulative tar entry limit exceeded");
      const field = (position, length) => header.subarray(position, position + length).toString("utf8").replace(/\0.*$/s, "");
      const octal = (value) => { requireValue(/^[0-7]+$/.test(value.trim()), "unsupported tar number"); return Number.parseInt(value.trim(), 8); };
      const storedChecksum = octal(field(148, 8));
      const actualChecksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      requireValue(storedChecksum === actualChecksum, "invalid image tar header checksum");
      const length = octal(field(124, 12));
      requireValue(Number.isSafeInteger(length) && offset + 512 + Math.ceil(length / 512) * 512 <= end, "invalid image tar entry size");
      const type = field(156, 1) || "0";
      const dataOffset = offset + 512;
      if (type === "x" || type === "g") {
        requireValue(length <= 64 * 1024, "oversized tar PAX metadata");
        const data = await read(dataOffset, length);
        for (let cursor = 0; cursor < data.length;) {
          const space = data.indexOf(32, cursor);
          const count = Number(data.subarray(cursor, space).toString());
          requireValue(space > cursor && Number.isSafeInteger(count) && count > space - cursor + 2 && cursor + count <= data.length && data[cursor + count - 1] === 10, "invalid tar PAX metadata");
          const pair = data.subarray(space + 1, cursor + count - 1).toString("utf8");
          const separator = pair.indexOf("=");
          requireValue(separator > 0 && !pair.startsWith("GNU.sparse"), "unsupported tar PAX metadata");
          const key = pair.slice(0, separator);
          requireValue(!["path", "size", "linkpath"].includes(key) || type === "x", "unsafe global tar PAX metadata");
          if (type === "x") extended[key] = pair.slice(separator + 1);
          cursor += count;
        }
      } else if (type === "L" || type === "K") {
        requireValue(length <= 64 * 1024, "oversized tar long-name metadata");
        if (type === "L") longName = (await read(dataOffset, length)).toString("utf8").replace(/\0.*$/s, "");
      } else {
        const prefix = field(345, 155);
        const rawName = extended.path ?? longName ?? `${prefix ? `${prefix}/` : ""}${field(0, 100)}`;
        const name = rawName.replace(/^\.\//, "").replace(/\/$/, "");
        requireValue(!/[\x00-\x1f\x7f\\]/.test(name) && !name.startsWith("/") && !name.split("/").includes(".."), "unsafe image tar path");
        requireValue(extended.size === undefined || Number(extended.size) === length, "unsupported tar PAX size override");
        entries.push({ name, type, offset: dataOffset, size: length });
        extended = {};
        longName = undefined;
      }
      offset += 512 + Math.ceil(length / 512) * 512;
    }
    fail("missing tar end marker");
  } finally { await handle.close(); }
}

async function tarJson(filename, entry) {
  requireValue(entry && entry.type === "0" && entry.size <= 16 * 1024 * 1024, "missing or oversized image JSON entry");
  const handle = await open(filename, "r");
  try {
    const buffer = Buffer.alloc(entry.size);
    const { bytesRead } = await handle.read(buffer, 0, entry.size, entry.offset);
    requireValue(bytesRead === entry.size, "truncated image JSON entry");
    return { value: parseJson(buffer.toString("utf8")), hash: sha256(buffer) };
  } finally { await handle.close(); }
}

// Build-directory naming uses the actual config bytes, never Docker 29's
// descriptor-valued .Id. Full archive/descriptor checks still precede publish.
export async function imageArchiveConfigDigest(filename) {
  await regularFile(filename);
  const entries = new Map((await tarEntries(filename)).map(entry => [entry.name, entry]));
  const records = (await tarJson(filename, entries.get("manifest.json"))).value;
  requireValue(Array.isArray(records) && records.length === 1, "image archive must contain exactly one image");
  safePath(records[0].Config, "image config path");
  return `sha256:${(await tarJson(filename, entries.get(records[0].Config))).hash}`;
}

async function imageDescriptors(filename, byName, record, config) {
  const identities = new Map(), kinds = new Map();
  if (!byName.has("index.json")) return { identities, kinds };
  const seen = new Set();
  const attestations = [], selectedRuntimeLeaves = new Set();
  const descriptorEntry = descriptor => {
    requireValue(descriptor && /^sha256:[a-f0-9]{64}$/.test(descriptor.digest), "invalid image descriptor digest");
    const entry = byName.get(`blobs/sha256/${descriptor.digest.slice(7)}`);
    requireValue(entry?.type === "0" && entry.size === descriptor.size, "missing or mismatched image descriptor size");
    return entry;
  };
  async function visit(descriptor, depth = 0) {
    requireValue(depth < 8 && seen.size < 256 && !seen.has(descriptor.digest), "image descriptor cycle/limit");
    seen.add(descriptor.digest);
    const value = (await tarJson(filename, descriptorEntry(descriptor))).value;
    requireValue(value.schemaVersion === 2, "invalid image descriptor schema");
    requireValue(value.mediaType === undefined || value.mediaType === descriptor.mediaType, "image descriptor media type mismatch");
    let selected = false;
    if (["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"].includes(descriptor.mediaType)) {
      requireValue(Array.isArray(value.manifests), "invalid image index descriptors");
      for (const child of value.manifests) {
        if (await visit(child, depth + 1)) {
          if (child.platform) requireValue(child.platform.os === config.value.os && child.platform.architecture === config.value.architecture, "selected image descriptor platform mismatch");
          selected = true;
        }
      }
    } else {
      requireValue(["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"].includes(descriptor.mediaType), "unsupported image descriptor media type");
      descriptorEntry(value.config);
      requireValue(Array.isArray(value.layers), "invalid image layer descriptors");
      for (const layer of value.layers) descriptorEntry(layer);
      if (value.config.digest === `sha256:${config.hash}`) {
        requireValue(["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"].includes(value.config.mediaType), "unsupported image config descriptor");
        requireValue(value.layers.length === record.Layers.length, "image descriptor layer count mismatch");
        for (const [index, layer] of value.layers.entries()) {
          requireValue(record.Layers[index] === `blobs/sha256/${layer.digest.slice(7)}`, "image layer descriptor mismatch");
          const kind = ({ "application/vnd.oci.image.layer.v1.tar": "tar", "application/vnd.oci.image.layer.v1.tar+gzip": "gzip",
            "application/vnd.docker.image.rootfs.diff.tar": "tar", "application/vnd.docker.image.rootfs.diff.tar.gzip": "gzip" })[layer.mediaType];
          requireValue(kind, "unsupported image layer compression media type");
          kinds.set(record.Layers[index], kind);
        }
        selected = true;
        selectedRuntimeLeaves.add(descriptor.digest);
      } else {
        // Buildx adds non-runtime in-toto attestation manifests. A second
        // runtime image could otherwise hide uninspected compressed layers.
        requireValue(descriptor.platform?.os === "unknown" && descriptor.platform?.architecture === "unknown"
          && descriptor.annotations?.["vnd.docker.reference.type"] === "attestation-manifest"
          && value.layers.length > 0 && value.layers.every(layer => layer.mediaType === "application/vnd.in-toto+json"), "unselected image is not a supported attestation");
        attestations.push(descriptor.annotations["vnd.docker.reference.digest"]);
      }
    }
    if (selected) identities.set(descriptor.digest, { digest: descriptor.digest, mediaType: descriptor.mediaType, size: descriptor.size });
    return selected;
  }
  const index = (await tarJson(filename, byName.get("index.json"))).value;
  requireValue(index.schemaVersion === 2 && Array.isArray(index.manifests), "invalid OCI archive index");
  for (const descriptor of index.manifests) {
    const reference = record.RepoTags[0], normalize = name => name.replace(/^docker\.io\/(?:library\/)?/, "");
    const named = descriptor.annotations?.["io.containerd.image.name"], tag = descriptor.annotations?.["org.opencontainers.image.ref.name"];
    if (named !== undefined) requireValue(typeof named === "string" && normalize(named) === normalize(reference), "OCI index image reference mismatch");
    if (tag !== undefined) requireValue(typeof tag === "string" && [reference.slice(reference.lastIndexOf(":") + 1), normalize(reference)].includes(normalize(tag)), "OCI index tag reference mismatch");
    await visit(descriptor);
  }
  for (const digest of attestations) requireValue(selectedRuntimeLeaves.has(digest), "unbound runtime-leaf image attestation reference");
  requireValue(identities.size > 0, "OCI descriptors do not bind the selected image config");
  return { identities, kinds };
}

async function decodeImageLayer(filename, layer, destination, remaining, declaredKind) {
  requireValue(layer.size <= maxLayerBytes, "compressed image layer size limit exceeded");
  const handle = await open(filename, "r");
  let header;
  try { header = Buffer.alloc(Math.min(layer.size, 65536)); await handle.read(header, 0, header.length, layer.offset); }
  finally { await handle.close(); }
  const gzip = header[0] === 0x1f && header[1] === 0x8b;
  requireValue(!declaredKind || declaredKind === (gzip ? "gzip" : "tar"), "unsupported image layer compression or descriptor mismatch");
  if (!gzip) {
    requireValue(!["28b52ffd", "fd377a58", "425a68", "504b0304"].some(magic => header.toString("hex").startsWith(magic)), "unsupported image layer compression");
    requireValue(layer.size <= remaining, "decoded image size limit exceeded");
    return { filename, offset: layer.offset, size: layer.size };
  }
  requireValue(header.length >= 18 && header[2] === 8 && (header[3] & 0xe0) === 0, "invalid gzip image layer header");
  let start = 10;
  if (header[3] & 4) { requireValue(start + 2 <= header.length, "invalid gzip extra header"); start += 2 + header.readUInt16LE(start); }
  for (const flag of [8, 16]) if (header[3] & flag) { const end = header.indexOf(0, start); requireValue(end >= start, "oversized/invalid gzip text header"); start = end + 1; }
  if (header[3] & 2) start += 2;
  requireValue(start < header.length && start + 8 < layer.size, "oversized/invalid gzip header");
  const limit = Math.min(maxLayerBytes, remaining);
  let size = 0;
  const bound = new Transform({ transform(chunk, _, callback) {
    size += chunk.length;
    callback(size > limit ? Error("decoded image layer size limit exceeded") : null, chunk);
  } });
  const inflate = createInflateRaw();
  try {
    await pipeline(createReadStream(filename, { start: layer.offset + start, end: layer.offset + layer.size - 1 }), inflate, bound,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    // Raw inflate identifies the end of exactly one DEFLATE member. Gunzip by
    // itself accepts concatenated members and zero padding, which we forbid.
    requireValue(start + inflate.bytesWritten + 8 === layer.size, "single gzip member required (trailing bytes forbidden)");
    let validated = 0;
    await pipeline(createReadStream(filename, { start: layer.offset, end: layer.offset + layer.size - 1 }), createGunzip(),
      new Writable({ write(chunk, _, callback) { validated += chunk.length; callback(validated > limit ? Error("decoded image layer size limit exceeded") : null); } }));
    requireValue(validated === size, "invalid gzip decoded length");
  } catch (error) {
    if (/decoded.*limit|single gzip/.test(error.message)) throw error;
    fail("invalid gzip image layer (header/checksum/truncation)");
  }
  return { filename: destination, offset: 0, size };
}

async function inspectArchive(filename) {
  const staging = await mkdtemp(path.join(tmpdir(), "gateway-image-layers-"));
  try { return await inspectArchiveLayers(filename, staging); }
  finally { await rm(staging, { recursive: true, force: true }); }
}
async function inspectArchiveLayers(filename, staging) {
  requireValue((await regularFile(filename)).size <= maxImageBytes, "image archive size limit exceeded");
  const entries = await tarEntries(filename);
  const byName = new Map();
  for (const entry of entries) {
    requireValue(entry.type === "0" || entry.type === "5", "image archive contains a link or special file");
    rejectSecretName(entry.name);
    requireValue(!byName.has(entry.name), "duplicate image archive path");
    byName.set(entry.name, entry);
    if (/^blobs\/sha256\//.test(entry.name) && entry.type === "0") {
      requireValue(/^blobs\/sha256\/[a-f0-9]{64}$/.test(entry.name) && entry.size <= maxLayerBytes, "invalid image blob path/size");
      requireValue(await digestRange(filename, entry.offset, entry.size, false) === entry.name.slice(-64), "image blob digest mismatch");
    }
  }
  const records = (await tarJson(filename, byName.get("manifest.json"))).value;
  requireValue(Array.isArray(records) && records.length === 1, "image archive must contain exactly one image");
  const record = records[0];
  safePath(record.Config, "image config path");
  requireValue(Array.isArray(record.RepoTags) && record.RepoTags.length === 1 && Array.isArray(record.Layers) && record.Layers.length > 0, "image archive must have one tag and nonempty layers");
  const reference = record.RepoTags[0];
  requireValue(typeof reference === "string" && /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(reference), "unsafe image repository/tag");
  for (const entry of entries) if (entry.type === "0" && !record.Layers.includes(entry.name)) await digestRange(filename, entry.offset, entry.size);
  const config = await tarJson(filename, byName.get(record.Config));
  const diffIds = config.value.rootfs?.diff_ids;
  requireValue(Array.isArray(diffIds) && diffIds.length === record.Layers.length && diffIds.length <= 128
    && diffIds.every(digest => /^sha256:[a-f0-9]{64}$/.test(digest)), "image layer digest count/format mismatch");
  const { identities, kinds } = await imageDescriptors(filename, byName, record, config);
  let decodedBytes = 0;
  const entryBudget = { count: 0 };
  let visibleInventory;
  const blockedInventoryAncestors = new Set();
  const seenLayers = new Set();
  for (const [index, name] of record.Layers.entries()) {
    safePath(name, "image layer path");
    requireValue(!seenLayers.has(name), "duplicate image layer");
    seenLayers.add(name);
    const layer = byName.get(name);
    requireValue(layer?.type === "0", "missing image layer");
    const decoded = await decodeImageLayer(filename, layer, path.join(staging, `${index}.tar`), maxImageBytes - decodedBytes, kinds.get(name));
    decodedBytes += decoded.size;
    requireValue(`sha256:${await digestRange(decoded.filename, decoded.offset, decoded.size, false)}` === diffIds[index], "image layer digest mismatch");
    const members = await tarEntries(decoded.filename, decoded.offset, decoded.size, entryBudget);
    for (const member of members) if (member.type === "0") await digestRange(decoded.filename, member.offset, member.size);
    // OCI whiteouts remove only lower-layer entries, regardless of their tar
    // ordering relative to same-layer additions. First mask the old inventory
    // for every deleted/opaque ancestor (including the image root), then apply
    // this layer's entries. Keep offsets and parse only the final visible file.
    for (const member of members) {
      const basename = path.posix.basename(member.name);
      const directory = path.posix.dirname(member.name);
      if (!basename.startsWith(".wh.")) continue;
      requireValue(member.type === "0" && member.size === 0, "invalid OCI whiteout marker");
      const target = basename === ".wh..wh..opq" ? directory : path.posix.join(directory, basename.slice(4));
      if (target === "." || target === inventoryPath || inventoryPath.startsWith(`${target}/`)) visibleInventory = undefined;
      for (const ancestor of blockedInventoryAncestors) {
        if (target === "." || ancestor.startsWith(`${target}/`) || (basename !== ".wh..wh..opq" && ancestor === target)) blockedInventoryAncestors.delete(ancestor);
      }
    }
    for (const member of members) {
      rejectSecretName(member.name);
      if (member.name === inventoryPath) {
        visibleInventory = { ...member, filename: decoded.filename };
      } else if (inventoryPath.startsWith(`${member.name}/`)) {
        if (member.type === "5") blockedInventoryAncestors.delete(member.name);
        else {
          blockedInventoryAncestors.add(member.name);
          visibleInventory = undefined;
        }
      }
    }
    // A symlink/non-directory ancestor cannot make these literal archive
    // coordinates visible. Recreating the directory later does not resurrect
    // its old contents; a fresh inventory entry is required as well.
    if (blockedInventoryAncestors.size > 0) visibleInventory = undefined;
  }
  requireValue(visibleInventory?.type === "0", "image has no final visible regular-file package inventory");
  const imageInventory = await tarJson(visibleInventory.filename, visibleInventory);
  validateInventory(imageInventory.value);
  return {
    configDigest: `sha256:${config.hash}`,
    platform: `${config.value.os}/${config.value.architecture}`,
    repository: reference.slice(0, reference.lastIndexOf(":")), tag: reference.slice(reference.lastIndexOf(":") + 1),
    labels: config.value.config?.Labels ?? {}, inventory: imageInventory.value, inventorySha256: imageInventory.hash, identities,
  };
}

function archiveName(platform) { return `gateway-image-${platform.replace("/", "-")}.tar`; }
function releaseId(manifest) { return `${manifest.gatewayVersion}-${manifest.gitCommit}-${manifest.image.configDigest.slice(7, 23)}${manifest.testMode ? "-test" : ""}`; }

export function applianceEnv(manifest) {
  // This is an exact allowlist, never arbitrary JSON-to-shell serialization.
  // Task 2 must validate each key/value before use, never source a site file
  // from this bundle or accept command substitutions/quotes/extra env keys.
  const values = {
    GATEWAY_RELEASE_SCHEMA: manifest.schema,
    GATEWAY_RELEASE_ID: manifest.releaseId,
    GATEWAY_VERSION: manifest.gatewayVersion,
    GATEWAY_GIT_COMMIT: manifest.gitCommit,
    GATEWAY_GIT_COMMIT_TIMESTAMP: manifest.gitCommitTimestamp,
    GATEWAY_RELEASE_PLATFORM: manifest.platform,
    GATEWAY_RELEASE_TEST_MODE: manifest.testMode ? "1" : "0",
    GATEWAY_RELEASE_POLICY_SHA256: manifest.policySha256,
    GATEWAY_LOCK_SHA256: manifest.lockSha256,
    GATEWAY_IMAGE_REPOSITORY: manifest.image.repository,
    GATEWAY_IMAGE_TAG: manifest.image.tag,
    GATEWAY_IMAGE_CONFIG_DIGEST: manifest.image.configDigest,
    ...(manifest.image.descriptorDigest ? { GATEWAY_IMAGE_DESCRIPTOR_DIGEST: manifest.image.descriptorDigest } : {}),
    GATEWAY_IMAGE_ARCHIVE: manifest.image.archive,
  };
  for (const value of Object.values(values)) requireValue(typeof value === "string" && /^[A-Za-z0-9_./:+-]+$/.test(value), "unsafe appliance.env value");
  return Object.keys(values).sort().map((key) => `${key}=${values[key]}\n`).join("");
}

function makeSbom(manifest, inventory, policy) {
  const base = (id, name, version, extra = {}) => ({ SPDXID: id, name, versionInfo: version, downloadLocation: "NOASSERTION", filesAnalyzed: false,
    licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", copyrightText: "NOASSERTION", ...extra });
  const packages = [
    base("SPDXRef-Gateway", "@led-control/gateway", manifest.gatewayVersion, { downloadLocation: `git+${policy.source}.git@${manifest.gitCommit}` }),
    base("SPDXRef-BlueZ", "bluez", policy.bluez.version, { downloadLocation: `https://www.kernel.org/pub/linux/bluetooth/bluez-${policy.bluez.version}.tar.xz`,
      checksums: [{ algorithm: "SHA256", checksumValue: policy.bluez.sourceSha256 }] }),
    base("SPDXRef-Node", "node", inventory.node.version),
    ...inventory.os.packages.map((item) => base(`SPDXRef-OS-${sha256(`${item.name}:${item.architecture}`).slice(0, 24)}`, item.name, item.version,
      { sourceInfo: `Installed Debian ${inventory.os.version} package; architecture=${item.architecture}` })),
    ...inventory.node.packages.map((item) => base(`SPDXRef-NPM-${sha256(item.location).slice(0, 24)}`, item.name, item.version,
      { sourceInfo: `Installed Node package: ${item.location}`, licenseDeclared: /^[A-Za-z0-9.-]+$/.test(item.license) ? item.license : "NOASSERTION" })),
  ].sort((a, b) => a.SPDXID.localeCompare(b.SPDXID, "en"));
  return {
    spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT", name: `led-control-gateway-${manifest.releaseId}`,
    documentNamespace: `${policy.source}/releases/spdx/${manifest.releaseId}`,
    creationInfo: { created: manifest.gitCommitTimestamp, creators: ["Tool: led-control-gateway-release-bundle-1"] },
    packages,
    relationships: [{ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: "SPDXRef-Gateway" },
      ...packages.filter((item) => item.SPDXID !== "SPDXRef-Gateway").map((item) => ({ spdxElementId: "SPDXRef-Gateway", relationshipType: "CONTAINS", relatedSpdxElement: item.SPDXID }))],
  };
}

async function bundleFiles(directory, prefix = "") {
  requireValue((await lstat(directory)).isDirectory(), "bundle must be a directory, not a symlink");
  const files = [];
  for (const item of await readdir(directory)) {
    const name = prefix + item;
    rejectSecretName(name);
    safePath(name);
    const filename = path.join(directory, item);
    const status = await lstat(filename);
    if (status.isDirectory()) {
      requireValue(name === "docker", "extra directory in release bundle");
      files.push(...await bundleFiles(filename, `${name}/`));
    } else {
      await regularFile(filename);
      files.push(name);
    }
  }
  return files.sort();
}

async function verifyBundle(options) {
  const directory = path.resolve(options.bundle);
  const policy = await loadPolicy(options.policy ?? path.join(repository, "apps/gateway/release-policy.json"));
  const files = await bundleFiles(directory);
  const checksumText = await readFile(path.join(directory, checksumFile), "utf8");
  const checksumPaths = [];
  requireValue(checksumText.endsWith("\n"), "invalid checksum file");
  for (const line of checksumText.slice(0, -1).split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    requireValue(match, "invalid checksum line");
    const name = safePath(match[2], "checksum path");
    requireValue(name !== checksumFile && !checksumPaths.includes(name), "duplicate/self checksum path");
    checksumPaths.push(name);
    requireValue(files.includes(name), "missing checksum target");
    requireValue(await digestRange(path.join(directory, name), 0, undefined, !/^gateway-image-linux-(?:arm64|amd64)\.tar$/.test(name)) === match[1], `checksum mismatch: ${name}`);
  }
  requireValue(equal(checksumPaths, files.filter((name) => name !== checksumFile)), "checksum closure mismatch (extra/missing/unsorted file)");
  const manifest = await readJson(path.join(directory, "release-manifest.json"), true);
  keys(manifest, "schema releaseId gatewayVersion gitCommit gitCommitTimestamp lockSha256 source platform testMode policySha256 bluez firmwareCompatibility image inventorySha256 privateMaterialScan", "manifest");
  keys(manifest.image, `repository tag configDigest archive${manifest.image.descriptorDigest === undefined ? "" : " descriptorDigest"}`, "manifest image");
  requireValue(equal(manifest.privateMaterialScan, privateMaterialScan), "private-material scan profile mismatch");
  requireValue(manifest.schema === policy.schema && manifest.source === policy.source && manifest.policySha256 === sha256(canonicalJson(policy))
    && equal(manifest.bluez, policy.bluez) && equal(manifest.firmwareCompatibility, policy.firmwareCompatibility), "release policy/schema mismatch");
  requireValue(commitPattern.test(manifest.gitCommit) && versionPattern.test(manifest.gatewayVersion)
    && sha256Pattern.test(manifest.lockSha256) && sha256Pattern.test(manifest.inventorySha256), "invalid source commit/version/hash");
  requireValue(typeof manifest.gitCommitTimestamp === "string" && new Date(manifest.gitCommitTimestamp).toISOString() === manifest.gitCommitTimestamp, "invalid source timestamp");
  requireValue(typeof manifest.testMode === "boolean" && ["linux/arm64", "linux/amd64"].includes(manifest.platform), "invalid platform/test-mode");
  requireValue(!manifest.testMode || options["allow-test-mode"], "test-mode bundle is forbidden for production activation");
  requireValue(manifest.testMode || manifest.platform === policy.platform, "production platform mismatch");
  requireValue(!options["expected-commit"] || options["expected-commit"] === manifest.gitCommit, "expected source commit mismatch");
  requireValue(manifest.image.archive === archiveName(manifest.platform), "image archive/platform mismatch");
  requireValue(equal(files, ["appliance.env", checksumFile, "compose.yml", "docker/seccomp-bluez-mesh.json", manifest.image.archive, "release-manifest.json", "sbom.spdx.json"].sort()), "extra/missing release bundle file");
  const image = await inspectArchive(path.join(directory, manifest.image.archive));
  if (manifest.image.descriptorDigest !== undefined) requireValue(manifest.image.descriptorDigest === image.configDigest
    || image.identities.has(manifest.image.descriptorDigest), "image descriptor digest is not bound to selected config");
  requireValue(image.configDigest === manifest.image.configDigest && image.platform === manifest.platform
    && image.repository === manifest.image.repository && image.tag === manifest.image.tag, "image config digest/platform/reference mismatch");
  requireValue(manifest.releaseId === releaseId(manifest), "release ID mismatch");
  requireValue(image.inventorySha256 === manifest.inventorySha256, "embedded inventory hash mismatch");
  for (const [label, expected] of Object.entries(imageLabels(manifest, policy))) requireValue(image.labels[label] === expected, `image label mismatch: ${label}`);
  requireValue(await readFile(path.join(directory, "appliance.env"), "utf8") === applianceEnv(manifest), "appliance.env allowlist/value mismatch");
  requireValue(equal(await readJson(path.join(directory, "sbom.spdx.json"), true), makeSbom(manifest, image.inventory, policy)), "SPDX inventory/provenance mismatch");
  return manifest;
}

async function sourceMetadata(source, testMode) {
  requireValue((await lstat(source)).isDirectory(), "source must be a non-symlink directory");
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  requireValue(git("status", "--porcelain", "--untracked-files=all") === "", "a clean Git checkout is required (including untracked files)");
  const pkg = await readJson(path.join(source, "apps/gateway/package.json"));
  requireValue(pkg.name === "@led-control/gateway" && versionPattern.test(pkg.version), "invalid Gateway package version");
  const gitCommit = git("rev-parse", "HEAD");
  requireValue(commitPattern.test(gitCommit), "full lowercase 40-character source commit required");
  const lock = path.join(source, "pnpm-lock.yaml");
  await regularFile(lock);
  return { gitCommit, gitCommitTimestamp: new Date(Number(git("show", "-s", "--format=%ct", "HEAD")) * 1000).toISOString(), gatewayVersion: pkg.version,
    lockSha256: await digestRange(lock), testMode };
}

async function createBundle(options) {
  const source = path.resolve(options.source ?? repository);
  const output = path.resolve(options.output);
  try { await lstat(output); fail("release directory already exists; refusing overwrite"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const policyFile = path.join(source, "apps/gateway/release-policy.json");
  const policy = await loadPolicy(policyFile);
  const platform = options.platform ?? policy.platform;
  const testMode = options["test-mode"] === true;
  requireValue(platform === policy.platform || testMode, "platform override requires explicit --test-mode");
  requireValue(["linux/arm64", "linux/amd64"].includes(platform), "unsupported image platform");
  const metadata = await sourceMetadata(source, testMode);
  await regularFile(options["image-archive"]);
  const image = await inspectArchive(options["image-archive"]);
  const inspect = await readJson(options["image-inspect"]);
  requireValue(Array.isArray(inspect) && inspect.length === 1, "image config digest differs from Docker inspect");
  const descriptor = image.identities.get(inspect[0].Id);
  requireValue(inspect[0].Id === image.configDigest || (descriptor && equal(inspect[0].Descriptor, descriptor)), "image config digest or descriptor differs from Docker inspect");
  if (inspect[0].Descriptor !== undefined) requireValue(equal(inspect[0].Descriptor, image.identities.get(inspect[0].Descriptor.digest)), "Docker inspect descriptor is not bound to selected config");
  requireValue(`${inspect[0].Os}/${inspect[0].Architecture}` === platform && image.platform === platform, "image platform mismatch");
  requireValue(equal(inspect[0].RepoTags, [`${image.repository}:${image.tag}`]) && equal(inspect[0].Config?.Labels, image.labels), "Docker inspect image reference/labels mismatch");
  const suppliedInventory = validateInventory(await readJson(options.inventory, true));
  requireValue(equal(suppliedInventory, image.inventory), "supplied inventory differs from image inventory");
  const manifest = {
    schema: policy.schema, ...metadata, source: policy.source, platform, policySha256: sha256(canonicalJson(policy)),
    bluez: policy.bluez, firmwareCompatibility: policy.firmwareCompatibility,
    image: { repository: image.repository, tag: image.tag, configDigest: image.configDigest, descriptorDigest: inspect[0].Id, archive: archiveName(platform) },
    inventorySha256: image.inventorySha256,
    privateMaterialScan,
  };
  manifest.releaseId = releaseId(manifest);
  for (const [label, expected] of Object.entries(imageLabels(manifest, policy))) requireValue(image.labels[label] === expected, `image label mismatch: ${label}`);
  // mkdir is exclusive: an existing release, even an empty one, is immutable.
  // Only this invocation's newly created directory may be removed on failure.
  await mkdir(output);
  try {
    await mkdir(path.join(output, "docker"));
    for (const [input, destination] of [[options["image-archive"], manifest.image.archive],
      [path.join(source, "apps/gateway/compose.raspberry-pi.yml"), "compose.yml"],
      [path.join(source, "apps/gateway/docker/seccomp-bluez-mesh.json"), "docker/seccomp-bluez-mesh.json"]]) {
      await regularFile(input);
      await copyFile(input, path.join(output, destination));
    }
    await writeFile(path.join(output, "release-manifest.json"), canonicalJson(manifest), { flag: "wx" });
    await writeFile(path.join(output, "sbom.spdx.json"), canonicalJson(makeSbom(manifest, suppliedInventory, policy)), { flag: "wx" });
    await writeFile(path.join(output, "appliance.env"), applianceEnv(manifest), { flag: "wx" });
    const lines = [];
    for (const file of await bundleFiles(output)) lines.push(`${await digestRange(path.join(output, file), 0, undefined, file !== manifest.image.archive)}  ${file}\n`);
    await writeFile(path.join(output, checksumFile), lines.join(""), { flag: "wx" });
    await verifyBundle({ bundle: output, policy: policyFile, "allow-test-mode": testMode, "expected-commit": metadata.gitCommit });
    // Catch source changes while Docker metadata/files were being assembled.
    requireValue(equal(await sourceMetadata(source, testMode), metadata), "source changed while creating bundle");
    return manifest;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function collectInventory(options) {
  const root = await realpath(options.root);
  const release = await readFile("/etc/os-release", "utf8");
  const osField = (key) => new RegExp(`^${key}=["']?([^"'\\n]+)`, "m").exec(release)?.[1];
  const output = execFileSync("dpkg-query", ["-W", "-f=${db:Status-Abbrev}\t${Package}\t${Version}\t${Architecture}\n"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const packages = [];
  const seen = new Set();
  const visit = async (directory, collectionRoot, prefix) => {
    const resolved = await realpath(directory);
    requireValue(resolved === collectionRoot || resolved.startsWith(`${collectionRoot}${path.sep}`), "Node inventory path escapes runtime root");
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const entries = await readdir(resolved, { withFileTypes: true });
    if (entries.some((entry) => entry.name === "package.json" && entry.isFile())) {
      const pkg = parseJson(await readFile(path.join(resolved, "package.json"), "utf8"));
      if (typeof pkg.name === "string" && typeof pkg.version === "string") packages.push({ name: pkg.name, version: pkg.version,
        location: `${prefix}/${path.relative(collectionRoot, resolved).split(path.sep).join("/")}`, license: typeof pkg.license === "string" ? pkg.license : "NOASSERTION" });
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(path.join(resolved, entry.name), collectionRoot, prefix);
      else if (entry.isSymbolicLink()) {
        const target = await realpath(path.join(resolved, entry.name));
        if ((await lstat(target)).isDirectory()) await visit(target, collectionRoot, prefix);
      }
    }
  };
  const applicationModules = await realpath(path.join(root, "node_modules"));
  await visit(applicationModules, applicationModules, "node_modules");
  // node:22-bookworm-slim also ships npm/corepack and their Node dependencies.
  // Leaving global packages out would under-report the final runtime image.
  const globalModules = await realpath("/usr/local/lib/node_modules");
  await visit(globalModules, globalModules, "global_node_modules");
  const value = validateInventory({ schema: "led-control-gateway-inventory/v1", os: { id: osField("ID"), version: osField("VERSION_ID"),
    packages: output.trimEnd().split("\n").filter((line) => line.startsWith("ii ")).map((line) => {
      const [, name, version, architecture] = line.split("\t"); return { name, version, architecture };
    }).sort((a, b) => `${a.name}:${a.architecture}`.localeCompare(`${b.name}:${b.architecture}`, "en")) },
    node: { version: process.versions.node, packages: packages.sort((a, b) => a.location.localeCompare(b.location, "en")) } });
  await writeFile(options.output, canonicalJson(value), { flag: "wx" });
}

async function main(argv) {
  const [command, ...args] = argv;
  const definitions = {
    create: { values: ["source", "image-archive", "image-inspect", "inventory", "output", "platform"], flags: ["test-mode"], required: ["image-archive", "image-inspect", "inventory", "output"] },
    verify: { values: ["bundle", "policy", "expected-commit"], flags: ["allow-test-mode"], required: ["bundle"] },
    inventory: { values: ["root", "output"], flags: [], required: ["root", "output"] },
  };
  try {
    const definition = definitions[command];
    requireValue(definition, "usage: gateway-release-bundle.mjs create|verify|inventory --option value");
    const options = {};
    while (args.length) {
      const argument = args.shift();
      const key = argument.slice(2);
      requireValue(argument.startsWith("--") && [...definition.values, ...definition.flags].includes(key), `unknown option: ${argument}`);
      requireValue(options[key] === undefined, `duplicate option: ${argument}`);
      options[key] = definition.flags.includes(key) ? true : args.shift();
      requireValue(options[key] === true || (typeof options[key] === "string" && !options[key].startsWith("--")), `missing option value: ${argument}`);
    }
    for (const key of definition.required) requireValue(options[key], `missing --${key}`);
    if (options["expected-commit"]) requireValue(commitPattern.test(options["expected-commit"]), "expected commit must be a full 40-character SHA");
    if (command === "inventory") await collectInventory(options);
    else {
      const manifest = command === "create" ? await createBundle(options) : await verifyBundle(options);
      process.stdout.write(`${manifest.releaseId}\n`);
    }
  } catch (error) {
    // Never print inspected JSON, image contents, env values or key material.
    process.stderr.write(`release bundle ${command === "verify" ? "verification" : "creation"} failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main(process.argv.slice(2));
