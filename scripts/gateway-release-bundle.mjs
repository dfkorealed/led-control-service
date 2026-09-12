#!/usr/bin/env node
// Build/CI tooling only. The Pi release manager consumes checksum-protected,
// allowlisted appliance.env; it must not assume Node is installed on the host.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repository = path.resolve(import.meta.dirname, "..");
const inventoryPath = "usr/local/share/gateway-release-inventory.json";
const checksumFile = "checksums.sha256";
const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
const privateMaterialScan = {
  profile: "led-control-private-material/v1",
  scope: "bundle-files-and-all-uncompressed-image-layer-bytes",
  pem: "literal-private-key-markers",
  der: "node-crypto-pkcs1-pkcs8-sec1-and-passphrase-required-pkcs8",
  base64: "one-standard-base64-layer-with-ascii-whitespace",
  maxDerBytes: 65536,
  maxBase64CandidateChars: 131072,
  oversizedRecognizedCandidates: "reject",
  notCovered: ["general-secrets", "decryption", "decompression", "other-encodings-or-obfuscation"],
};
const privatePemMarker = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
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
    && !/(?:^|[-_.])(?:private[-_.]?)?key(?:$|[-_.])/i.test(filename), `secret filename is forbidden: ${value}`);
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

function privateDerType(bytes, sequence) {
  const { body, end } = sequence;
  if (bytes[body] === 0x02 && bytes[body + 1] === 1 && [0, 1].includes(bytes[body + 2])) {
    return { 0x30: "pkcs8", 0x02: "pkcs1", 0x04: "sec1" }[bytes[body + 3]];
  }
  // EncryptedPrivateKeyInfo has AlgorithmIdentifier followed by OCTET STRING.
  // Only Node crypto's explicit missing-passphrase outcome identifies a key;
  // arbitrary ASN.1 sequences and public SPKI/certificates are not rejected.
  const algorithm = derSequence(bytes, body);
  if (algorithm && algorithm.end < end && bytes[algorithm.body] === 0x06 && bytes[algorithm.end] === 0x04) return "pkcs8";
  return undefined;
}

function rejectPrivateDer(bytes) {
  for (let offset = bytes.indexOf(0x30); offset !== -1; offset = bytes.indexOf(0x30, offset + 1)) {
    const sequence = derSequence(bytes, offset);
    const type = sequence && privateDerType(bytes, sequence);
    if (!type) continue;
    requireValue(sequence.end - offset <= privateMaterialScan.maxDerBytes, "private key material candidate exceeds DER scan bound");
    if (sequence.end > bytes.length) continue; // The bounded carry completes split DER objects.
    let detected = false;
    try {
      detected = createPrivateKey({ key: bytes.subarray(offset, sequence.end), format: "der", type }).type === "private";
    } catch (error) {
      detected = type === "pkcs8" && error.code === "ERR_MISSING_PASSPHRASE";
    }
    requireValue(!detected, "private key material is forbidden (DER)");
  }
}

function rejectPrivateContent(bytes) {
  const text = bytes.toString("latin1");
  requireValue(!privatePemMarker.test(text), "private key material is forbidden (PEM)");
  rejectPrivateDer(bytes);
}

function rejectPrivateBase64(text) {
  // One standard base64 layer, either a token in text/JSON or whitespace-
  // wrapped lines. This is intentionally not a general secret detector or a
  // recursive decoder. The exact profile and limits are part of the manifest.
  for (const token of text.matchAll(/[A-Za-z0-9+/=]{32,}/g)) {
    // A DER SEQUENCE starts with base64 M[A-P]; a PEM header starts with LS0t.
    // Locating that start also handles surrounding prose after whitespace is
    // normalized, without assuming an encoding starts at the stream boundary.
    for (const start of token[0].matchAll(/LS0tLS1CRUdJTi|M[A-P][A-Za-z0-9+/]{2}/g)) {
      const candidate = token[0].slice(start.index, start.index + privateMaterialScan.maxBase64CandidateChars);
      const prefix = Buffer.from(candidate.slice(0, 512), "base64");
      requireValue(!privatePemMarker.test(prefix.toString("latin1")), "private key material is forbidden (base64 PEM)");
      const sequence = derSequence(prefix, 0);
      if (!sequence) continue;
      const algorithm = derSequence(prefix, sequence.body);
      if (!privateDerType(prefix, sequence) && !(algorithm && prefix[algorithm.body] === 0x06)) continue;
      requireValue(sequence.end <= privateMaterialScan.maxDerBytes, "private key material candidate exceeds DER scan bound");
      rejectPrivateDer(Buffer.from(candidate.slice(0, Math.ceil(sequence.end / 3) * 4), "base64"));
    }
  }
}

async function digestRange(filename, start = 0, size, scanSecrets = true) {
  const hash = createHash("sha256");
  let tail = Buffer.alloc(0);
  let base64Tail = "";
  if (size === 0) return hash.digest("hex");
  for await (const chunk of createReadStream(filename, { start, ...(size === undefined ? {} : { end: start + size - 1 }) })) {
    hash.update(chunk);
    if (scanSecrets) {
      const bytes = Buffer.concat([tail, chunk]);
      rejectPrivateContent(bytes);
      tail = bytes.subarray(-privateMaterialScan.maxDerBytes);
      // Keep a separate normalized carry so arbitrary ASCII whitespace and
      // short final base64 lines cannot consume or split the candidate window.
      const base64Text = base64Tail + chunk.toString("latin1").replace(/[\t\r\n ]/g, "");
      rejectPrivateBase64(base64Text);
      base64Tail = base64Text.slice(-privateMaterialScan.maxBase64CandidateChars);
    }
  }
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

// docker save contains uncompressed tar layers. Index bytes in-place: never
// extract an untrusted archive to disk or follow its paths/symlinks. OS layer
// symlinks are normal; release-directory symlinks are separately forbidden.
async function tarEntries(filename, start = 0, size) {
  const handle = await open(filename, "r");
  const end = start + (size ?? (await handle.stat()).size);
  const entries = [];
  let offset = start;
  let extended = {};
  let longName;
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

async function inspectArchive(filename) {
  await regularFile(filename);
  const entries = await tarEntries(filename);
  const byName = new Map();
  for (const entry of entries) {
    requireValue(entry.type === "0" || entry.type === "5", "image archive contains a link or special file");
    rejectSecretName(entry.name);
    requireValue(!byName.has(entry.name), "duplicate image archive path");
    byName.set(entry.name, entry);
  }
  const records = (await tarJson(filename, byName.get("manifest.json"))).value;
  requireValue(Array.isArray(records) && records.length === 1, "image archive must contain exactly one image");
  const record = records[0];
  safePath(record.Config, "image config path");
  requireValue(Array.isArray(record.RepoTags) && record.RepoTags.length === 1 && Array.isArray(record.Layers) && record.Layers.length > 0, "image archive must have one tag and nonempty layers");
  const reference = record.RepoTags[0];
  requireValue(typeof reference === "string" && /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(reference), "unsafe image repository/tag");
  const config = await tarJson(filename, byName.get(record.Config));
  const diffIds = config.value.rootfs?.diff_ids;
  requireValue(Array.isArray(diffIds) && diffIds.length === record.Layers.length, "image layer digest count mismatch");
  let visibleInventory;
  const blockedInventoryAncestors = new Set();
  const seenLayers = new Set();
  for (const [index, name] of record.Layers.entries()) {
    safePath(name, "image layer path");
    requireValue(!seenLayers.has(name), "duplicate image layer");
    seenLayers.add(name);
    const layer = byName.get(name);
    requireValue(layer?.type === "0", "missing image layer");
    requireValue(`sha256:${await digestRange(filename, layer.offset, layer.size)}` === diffIds[index], "image layer digest mismatch");
    const members = await tarEntries(filename, layer.offset, layer.size);
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
        visibleInventory = member;
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
  const imageInventory = await tarJson(filename, visibleInventory);
  validateInventory(imageInventory.value);
  return {
    configDigest: `sha256:${config.hash}`,
    platform: `${config.value.os}/${config.value.architecture}`,
    repository: reference.slice(0, reference.lastIndexOf(":")), tag: reference.slice(reference.lastIndexOf(":") + 1),
    labels: config.value.config?.Labels ?? {}, inventory: imageInventory.value, inventorySha256: imageInventory.hash,
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
    requireValue(await digestRange(path.join(directory, name)) === match[1], `checksum mismatch: ${name}`);
  }
  requireValue(equal(checksumPaths, files.filter((name) => name !== checksumFile)), "checksum closure mismatch (extra/missing/unsorted file)");
  const manifest = await readJson(path.join(directory, "release-manifest.json"), true);
  keys(manifest, "schema releaseId gatewayVersion gitCommit gitCommitTimestamp lockSha256 source platform testMode policySha256 bluez firmwareCompatibility image inventorySha256 privateMaterialScan", "manifest");
  keys(manifest.image, "repository tag configDigest archive", "manifest image");
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
  requireValue(Array.isArray(inspect) && inspect.length === 1 && inspect[0].Id === image.configDigest, "image config digest differs from Docker inspect");
  requireValue(`${inspect[0].Os}/${inspect[0].Architecture}` === platform && image.platform === platform, "image platform mismatch");
  requireValue(equal(inspect[0].RepoTags, [`${image.repository}:${image.tag}`]) && equal(inspect[0].Config?.Labels, image.labels), "Docker inspect image reference/labels mismatch");
  const suppliedInventory = validateInventory(await readJson(options.inventory, true));
  requireValue(equal(suppliedInventory, image.inventory), "supplied inventory differs from image inventory");
  const manifest = {
    schema: policy.schema, ...metadata, source: policy.source, platform, policySha256: sha256(canonicalJson(policy)),
    bluez: policy.bluez, firmwareCompatibility: policy.firmwareCompatibility,
    image: { repository: image.repository, tag: image.tag, configDigest: image.configDigest, archive: archiveName(platform) },
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
    for (const file of await bundleFiles(output)) lines.push(`${await digestRange(path.join(output, file))}  ${file}\n`);
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
