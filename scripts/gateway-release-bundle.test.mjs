import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

const repository = path.resolve(import.meta.dirname, "..");
const cli = path.join(repository, "scripts/gateway-release-bundle.mjs");
const policy = {
  schema: "led-control-gateway-release/v1",
  policyVersion: 1,
  source: "https://github.com/df-kjh/led-control-service",
  platform: "linux/arm64",
  bluez: { version: "5.82", sourceSha256: "0739fa608a837967ee6d5572b43fb89946a938d1c6c26127158aaefd743a790b" },
  firmwareCompatibility: {
    productIdentityFormat: 1,
    dimmingCommandWire: 2,
    automationSnapshotSchema: 1,
    vehicleSensorProtocol: 1,
    espIdfVersion: "v5.5.1",
    bluetoothCompanyId: "runtime-must-match-signed-firmware",
  },
};
const inventory = {
  schema: "led-control-gateway-inventory/v1",
  os: { id: "debian", version: "12", packages: [{ name: "libc6", version: "2.36-9+deb12u10", architecture: "arm64" }] },
  node: { version: "22.20.0", packages: [{ name: "mqtt", version: "5.15.2", location: "node_modules/.pnpm/mqtt@5.15.2/node_modules/mqtt", license: "MIT" }] },
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item, 2) + "\n";

function run(args, env = process.env) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 30_000, env });
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

function fails(result, reason) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release bundle (?:creation|verification) failed/);
  if (reason) assert.match(result.stderr, reason);
}

// Real ustar bytes, not a fake tar extension: production CLI must inspect the
// config/layer data without a Docker daemon, including malicious layer fixtures.
function tar(entries) {
  const blocks = [];
  for (const [name, value] of Object.entries(entries)) {
    const entry = typeof value === "object" && !Buffer.isBuffer(value) ? value : { data: value };
    const data = Buffer.from(entry.data ?? "");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156);
    if (entry.linkname) header.write(entry.linkname, 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const output = path.join(directory, "bundle");
  await mkdir(path.join(source, "apps/gateway/docker"), { recursive: true });
  for (const [file, value] of Object.entries({
    "apps/gateway/release-policy.json": canonical(policy),
    "apps/gateway/package.json": canonical({ name: "@led-control/gateway", version: "0.1.0" }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "apps/gateway/compose.raspberry-pi.yml": "services:\n  gateway-appliance:\n    image: ${GATEWAY_IMAGE_REPOSITORY}:${GATEWAY_IMAGE_TAG}\n",
    "apps/gateway/docker/seccomp-bluez-mesh.json": "{\"defaultAction\":\"SCMP_ACT_ERRNO\"}\n",
  })) await writeFile(path.join(source, file), value);
  if (options.withBuildScript) {
    await mkdir(path.join(source, "scripts"));
    for (const filename of ["gateway-release-bundle.mjs", "gateway-appliance-build.sh"]) {
      await writeFile(path.join(source, "scripts", filename), await readFile(path.join(repository, "scripts", filename)));
    }
  }
  const git = (args) => {
    const result = spawnSync("git", ["-C", source, ...args], {
      encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Release fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Release fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_DATE: "2026-09-12T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-12T00:00:00Z" },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "--quiet"]);
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "fixture"]);
  const commit = git(["rev-parse", "HEAD"]);
  const platform = options.platform ?? "linux/arm64";
  const labels = {
    "org.opencontainers.image.version": "0.1.0",
    "org.opencontainers.image.revision": commit,
    "org.opencontainers.image.created": "2026-09-12T00:00:00.000Z",
    "org.opencontainers.image.source": policy.source,
    "com.led-control.lock-sha256": hash("lockfileVersion: '9.0'\n"),
    "com.led-control.release-policy-sha256": hash(canonical(policy)),
    "com.led-control.bluez.version": policy.bluez.version,
    "com.led-control.bluez.source-sha256": policy.bluez.sourceSha256,
    "com.led-control.firmware-compatibility": JSON.stringify(JSON.parse(canonical(policy.firmwareCompatibility))),
    "com.led-control.release.test-mode": options.testMode ? "true" : "false",
  };
  options.mutateLabels?.(labels);
  const imageInventory = structuredClone(options.inventory ?? inventory);
  imageInventory.os.packages[0] && (imageInventory.os.packages[0].architecture = platform.split("/")[1]);
  const inventoryBytes = canonical(imageInventory);
  const layerObjects = options.layers?.(inventoryBytes) ?? [{ "usr/local/share/gateway-release-inventory.json": inventoryBytes, ...options.layerFiles }];
  const layers = layerObjects.map((entries) => tar(entries));
  const blobs = layers.map((bytes, index) => options.encodeLayer ? options.encodeLayer(bytes, index) : options.oci ? gzipSync(bytes) : bytes);
  const layerNames = blobs.map((bytes, index) => options.oci ? `blobs/sha256/${hash(bytes)}` : `layer-${index}/layer.tar`);
  const config = { architecture: platform.split("/")[1], os: "linux", config: { Labels: labels }, rootfs: { type: "layers", diff_ids: layers.map((layer) => `sha256:${hash(layer)}`) } };
  options.mutateConfig?.(config);
  const configBytes = canonical(config);
  const configDigest = `sha256:${hash(configBytes)}`;
  const configName = options.oci ? `blobs/sha256/${hash(configBytes)}` : `${hash(configBytes)}.json`;
  const imageTag = `${commit}${options.testMode ? "-test" : ""}`;
  const image = { Id: configDigest, Architecture: config.architecture, Os: config.os, Config: config.config, RepoTags: [`led-control-gateway:${imageTag}`] };
  const archiveEntries = { "manifest.json": JSON.stringify([{ Config: configName, RepoTags: [`led-control-gateway:${imageTag}`], Layers: layerNames }]),
    [configName]: configBytes, ...Object.fromEntries(layerNames.map((name, index) => [name, blobs[index]])) };
  if (options.oci) {
    const descriptor = (mediaType, bytes) => ({ mediaType, digest: `sha256:${hash(bytes)}`, size: Buffer.byteLength(bytes) });
    const manifest = { schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: descriptor("application/vnd.oci.image.config.v1+json", configBytes),
      layers: blobs.map(bytes => descriptor(bytes[0] === 0x1f ? "application/vnd.oci.image.layer.v1.tar+gzip" : "application/vnd.oci.image.layer.v1.tar", bytes)) };
    options.mutateOciManifest?.(manifest);
    const manifestBytes = canonical(manifest), manifestDescriptor = descriptor(manifest.mediaType, manifestBytes);
    const index = { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ ...manifestDescriptor, platform: { os: "linux", architecture: config.architecture } }] };
    if (options.extraOciImage) {
      const extraConfig = canonical({ architecture: "unknown", os: "unknown" }), payload = canonical({ _type: "https://in-toto.io/Statement/v0.1" });
      const extra = canonical({ schemaVersion: 2, mediaType: manifest.mediaType, config: descriptor("application/vnd.oci.image.config.v1+json", extraConfig), layers: [descriptor("application/vnd.in-toto+json", payload)] });
      for (const bytes of [extraConfig, payload, extra]) archiveEntries[`blobs/sha256/${hash(bytes)}`] = bytes;
      index.manifests.push({ ...descriptor(manifest.mediaType, extra), platform: { os: "unknown", architecture: "unknown" },
        ...(options.extraOciImage === "attestation" ? { annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": manifestDescriptor.digest } } : {}) });
    }
    options.mutateOciIndex?.(index);
    const indexBytes = canonical(index), indexDescriptor = descriptor(index.mediaType, indexBytes);
    Object.assign(archiveEntries, { "oci-layout": canonical({ imageLayoutVersion: "1.0.0" }),
      "index.json": canonical({ schemaVersion: 2, manifests: [{ ...indexDescriptor, annotations: { "io.containerd.image.name": `docker.io/library/led-control-gateway:${imageTag}`, "org.opencontainers.image.ref.name": imageTag } }] }),
      [`blobs/sha256/${hash(manifestBytes)}`]: manifestBytes, [`blobs/sha256/${hash(indexBytes)}`]: indexBytes });
    image.Id = indexDescriptor.digest; image.Descriptor = indexDescriptor; image.RootFS = { Type: "layers", Layers: config.rootfs.diff_ids };
  }
  options.mutateInspect?.(image);
  const archive = path.join(directory, "image.tar");
  options.mutateArchive?.(archiveEntries, { layerNames, configName });
  await writeFile(archive, tar(archiveEntries));
  const inspect = path.join(directory, "inspect.json");
  const inventoryFile = path.join(directory, "inventory.json");
  await writeFile(inspect, JSON.stringify([image]));
  await writeFile(inventoryFile, inventoryBytes);
  const createArgs = ["create", "--source", source, "--image-archive", archive, "--image-inspect", inspect,
    "--inventory", inventoryFile, "--output", output, ...(options.testMode ? ["--test-mode"] : []),
    ...(options.platform ? ["--platform", platform] : [])];
  const verifyArgs = ["verify", "--bundle", output, "--policy", path.join(source, "apps/gateway/release-policy.json")];
  return { directory, source, output, commit, configDigest, descriptorDigest: image.Id, createArgs, verifyArgs, archive, imageInventory, git };
}

async function created(t, options) {
  const result = await fixture(t, options);
  succeeds(run(result.createArgs));
  return result;
}

async function regularFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await regularFiles(path.join(directory, entry.name), `${name}/`));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}

async function checksums(output) {
  const lines = [];
  for (const file of await regularFiles(output)) {
    if (file !== "checksums.sha256") lines.push(`${hash(await readFile(path.join(output, file)))}  ${file}\n`);
  }
  await writeFile(path.join(output, "checksums.sha256"), lines.join(""));
}

async function updateJson(output, file, change) {
  const target = path.join(output, file);
  const value = JSON.parse(await readFile(target, "utf8"));
  change(value);
  await writeFile(target, canonical(value));
  await checksums(output);
}

// Rebind all non-secret provenance to an adversarial archive so a verify
// rejection proves content/overlay validation, not an unrelated stale hash.
async function replaceBundleImage(result, image) {
  const filename = path.join(result.output, "release-manifest.json");
  const manifest = JSON.parse(await readFile(filename, "utf8"));
  const previousId = manifest.releaseId;
  manifest.image.configDigest = image.configDigest;
  if (manifest.image.descriptorDigest !== undefined) manifest.image.descriptorDigest = image.descriptorDigest;
  manifest.releaseId = `${manifest.gatewayVersion}-${manifest.gitCommit}-${image.configDigest.slice(7, 23)}${manifest.testMode ? "-test" : ""}`;
  await writeFile(path.join(result.output, manifest.image.archive), await readFile(image.archive));
  await writeFile(filename, canonical(manifest));
  const envFile = path.join(result.output, "appliance.env");
  await writeFile(envFile, (await readFile(envFile, "utf8"))
    .replace(/^GATEWAY_IMAGE_CONFIG_DIGEST=.*$/m, `GATEWAY_IMAGE_CONFIG_DIGEST=${image.configDigest}`)
    .replace(/^GATEWAY_IMAGE_DESCRIPTOR_DIGEST=.*$/m, `GATEWAY_IMAGE_DESCRIPTOR_DIGEST=${image.descriptorDigest}`)
    .replace(/^GATEWAY_RELEASE_ID=.*$/m, `GATEWAY_RELEASE_ID=${manifest.releaseId}`));
  const sbomFile = path.join(result.output, "sbom.spdx.json");
  const sbom = JSON.parse(await readFile(sbomFile, "utf8"));
  sbom.name = sbom.name.replace(previousId, manifest.releaseId);
  sbom.documentNamespace = sbom.documentNamespace.replace(previousId, manifest.releaseId);
  await writeFile(sbomFile, canonical(sbom));
  await checksums(result.output);
}

test("Docker 29 gzip blobs bind index, selected manifest, compressed digest and uncompressed config diff IDs", async (t) => {
  const h = await fixture(t, { oci: true }); const env = { ...process.env, TMPDIR: h.directory };
  succeeds(run(h.createArgs, env)); succeeds(run(h.verifyArgs, env));
  const manifest = JSON.parse(await readFile(path.join(h.output, "release-manifest.json"), "utf8"));
  assert.equal(manifest.image.configDigest, h.configDigest);
  assert.equal(manifest.image.descriptorDigest, h.descriptorDigest);
  assert.notEqual(h.configDigest, h.descriptorDigest);
  assert.match(await readFile(path.join(h.output, "appliance.env"), "utf8"), new RegExp(`GATEWAY_IMAGE_DESCRIPTOR_DIGEST=${h.descriptorDigest}`));
  assert.equal((await readdir(h.directory)).some(name => name.startsWith("gateway-image-layers-")), false);
});

const gzipRejections = [
  ["compressed blob tamper", { mutateArchive: (entries, { layerNames }) => { entries[layerNames[0]] = gzipSync("different compressed bytes"); } }, /blob digest/],
  ["wrong diff ID", { mutateConfig: c => { c.rootfs.diff_ids[0] = `sha256:${"0".repeat(64)}`; } }, /layer digest/],
  ["corrupt checksum", { encodeLayer: bytes => { const gz = gzipSync(bytes); gz[gz.length - 8] ^= 1; return gz; } }, /gzip/],
  ["truncated member", { encodeLayer: bytes => gzipSync(bytes).subarray(0, -3) }, /gzip/],
  ["trailing zero bytes", { encodeLayer: bytes => Buffer.concat([gzipSync(bytes), Buffer.alloc(8)]) }, /gzip.*trailing|single gzip/],
  ["concatenated empty member", { encodeLayer: bytes => Buffer.concat([gzipSync(bytes), gzipSync("")]) }, /gzip.*trailing|single gzip/],
  ["unsupported compression", { encodeLayer: () => Buffer.from("28b52ffd00000000", "hex") }, /unsupported.*compression/],
  ["unsupported media type", { mutateOciManifest: m => { m.layers[0].mediaType = "application/vnd.oci.image.layer.v1.tar+zstd"; } }, /unsupported.*compression/],
  ["descriptor digest tamper", { mutateOciManifest: m => { m.layers[0].digest = `sha256:${"0".repeat(64)}`; } }, /descriptor/],
  ["descriptor size tamper", { mutateOciManifest: m => { m.layers[0].size++; } }, /descriptor/],
  ["wrong selected platform", { mutateOciIndex: i => { i.manifests[0].platform.architecture = "other"; } }, /platform/],
  ["unbound inspect descriptor", { mutateInspect: i => { i.Id = `sha256:${"0".repeat(64)}`; i.Descriptor.digest = i.Id; } }, /Docker inspect|descriptor/],
  ["unselected runtime image", { extraOciImage: "runtime" }, /unselected image/],
  ["index tag mismatch", { mutateArchive: entries => { const index=JSON.parse(entries["index.json"]);index.manifests[0].annotations["io.containerd.image.name"]="other:tag";entries["index.json"]=canonical(index); } }, /index.*reference/],
];
for (const [name, options, reason] of gzipRejections) test(`Docker 29 gzip rejects ${name} and cleans decoded staging`, async (t) => {
  const h = await fixture(t, { oci: true, ...options }); const env = { ...process.env, TMPDIR: h.directory };
  fails(run(h.createArgs, env), reason);
  if (!name.includes("inspect")) {
    const published = await created(t, { oci: true }); await replaceBundleImage(published, h);
    fails(run(published.verifyArgs, env), reason);
  }
  assert.equal((await readdir(h.directory)).some(name => name.startsWith("gateway-image-layers-")), false);
});
test("Docker 29 gzip rejects a 512 MiB expansion bomb before scanning or extracting its tar", async (t) => {
  const encoded = gzipSync(Buffer.alloc(512 * 1024 * 1024 + 1));
  const h = await fixture(t, { oci: true, encodeLayer: () => encoded });
  fails(run(h.createArgs, { ...process.env, TMPDIR: h.directory }), /decoded.*limit/);
  assert.equal((await readdir(h.directory)).some(name => name.startsWith("gateway-image-layers-")), false);
});
test("Docker 29 gzip preserves whiteout and private-material checks on decoded layer bytes", async (t) => {
  const hidden = await fixture(t, { oci: true, layers: bytes => [{ "usr/local/share/gateway-release-inventory.json": bytes }, { "usr/.wh..wh..opq": "" }] });
  fails(run(hidden.createArgs), /final visible/);
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "der", type: "pkcs8" });
  const privateLayer = await fixture(t, { oci: true, layerFiles: { "usr/share/allowed.bin": key } });
  fails(run(privateLayer.createArgs), /private key material/);
  const mixed = await fixture(t, { oci: true, layers: bytes => [{ "usr/local/share/gateway-release-inventory.json": bytes }, { "usr/share/public.txt": "ordinary" }], encodeLayer: (bytes, i) => i ? bytes : gzipSync(bytes) });
  succeeds(run(mixed.createArgs)); succeeds(run(mixed.verifyArgs));
});
test("Docker 29 gzip accepts only a selected image plus its bound non-runtime attestation", async (t) => {
  const h = await created(t, { oci: true, extraOciImage: "attestation" }); succeeds(run(h.verifyArgs));
});
test("legacy 13-key config-only bundles remain verifiable for rollback", async (t) => {
  const h = await created(t);
  await updateJson(h.output, "release-manifest.json", m => { delete m.image.descriptorDigest; });
  const env = path.join(h.output, "appliance.env"); await writeFile(env, (await readFile(env, "utf8")).replace(/^GATEWAY_IMAGE_DESCRIPTOR_DIGEST=.*\n/m, ""));
  await checksums(h.output); succeeds(run(h.verifyArgs));
});

test("OCI whiteouts require final visible inventory at every root/ancestor and ignore same-layer ordering", async (t) => {
  const entry = "usr/local/share/gateway-release-inventory.json";
  const markers = [".wh.usr", "usr/.wh.local", "usr/local/.wh.share", "usr/local/share/.wh.gateway-release-inventory.json",
    ".wh..wh..opq", "usr/.wh..wh..opq", "usr/local/.wh..wh..opq", "usr/local/share/.wh..wh..opq"];
  for (const marker of markers) {
    await t.test(`${marker}: later layer hides inventory`, async (t) => {
      const hidden = await fixture(t, { layers: (bytes) => [{ [entry]: bytes }, { [marker]: "" }] });
      fails(run(hidden.createArgs), /inventory/);
      const result = await created(t);
      await replaceBundleImage(result, hidden);
      fails(run(result.verifyArgs), /inventory/);
    });
    await t.test(`${marker}: later inventory survives earlier marker`, async (t) => {
      const result = await created(t, { layers: (bytes) => [{ [marker]: "" }, { [entry]: bytes }] });
      succeeds(run(result.verifyArgs));
    });
    for (const order of ["before", "after"]) await t.test(`${marker}: same-layer marker ${order} replacement`, async (t) => {
      const result = await created(t, { layers: (bytes) => {
        const old = JSON.parse(bytes);
        old.node.packages[0].version = "1.0.0";
        const entries = order === "before" ? { [marker]: "", [entry]: bytes } : { [entry]: bytes, [marker]: "" };
        return [{ [entry]: canonical(old) }, entries];
      } });
      succeeds(run(result.verifyArgs));
      const sbom = JSON.parse(await readFile(path.join(result.output, "sbom.spdx.json"), "utf8"));
      assert.ok(sbom.packages.some((item) => item.name === "mqtt" && item.versionInfo === "5.15.2"));
    });
  }
});

test("OCI inventory validation reads only the final visible regular-file contents", async (t) => {
  const result = await created(t, { layers: (bytes) => [
    { "usr/local/share/gateway-release-inventory.json": "not-json-no-longer-visible" },
    { ".wh.usr": "" }, { "usr/local/share/gateway-release-inventory.json": bytes },
  ] });
  succeeds(run(result.verifyArgs));
});

test("OCI ancestor replacement cannot revive a removed inventory or resolve it through a symlink", async (t) => {
  const entry = "usr/local/share/gateway-release-inventory.json";
  for (const ancestor of ["usr", "usr/local", "usr/local/share"]) await t.test(ancestor, async (t) => {
    for (const replacement of [{ data: "not-a-directory" }, { type: "2", linkname: "/outside" }]) {
      const hidden = await fixture(t, { layers: (bytes) => [{ [entry]: bytes }, { [ancestor]: replacement }, { [ancestor]: { type: "5" } }] });
      fails(run(hidden.createArgs), /inventory/);
    }
    const result = await created(t, { layers: (bytes) => [
      { [entry]: bytes }, { [ancestor]: { type: "2", linkname: "/outside" } },
      { [ancestor]: { type: "5" }, [entry]: bytes },
    ] });
    succeeds(run(result.verifyArgs));
  });
});

test("private-material content detection rejects ephemeral DER and base64 keys in allowed bundle/layer filenames", async (t) => {
  // Ephemeral test-only material, never operational keys or checked-in bytes.
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = ec.privateKey.export({ type: "pkcs8", format: "pem" });
  const der = ec.privateKey.export({ type: "pkcs8", format: "der" });
  const encryptedDer = ec.privateKey.export({ type: "pkcs8", format: "der", cipher: "aes-256-cbc", passphrase: "ephemeral-test-only" });
  const fixtures = {
    "DER PKCS8": der,
    "DER PKCS1": rsa.privateKey.export({ type: "pkcs1", format: "der" }),
    "DER SEC1": ec.privateKey.export({ type: "sec1", format: "der" }),
    "encrypted DER PKCS8": encryptedDer,
    "base64 encrypted DER": Buffer.from(encryptedDer.toString("base64")),
    "base64 PEM in text": Buffer.from(`value: ${Buffer.from(pem).toString("base64")}\n`),
    "wrapped base64 PEM": Buffer.from(Buffer.from(pem).toString("base64").match(/.{1,64}/g).join("\n")),
    "base64 DER in JSON": Buffer.from(JSON.stringify({ payload: der.toString("base64") })),
    "wrapped base64 DER short final line": Buffer.from(der.toString("base64").match(/.{1,80}/g).join("\n")),
    "spaced base64 DER": Buffer.from(der.toString("base64").split("").join(" \n")),
    "DER across stream boundary": Buffer.concat([Buffer.alloc(65530, 0), der]),
    "base64 PEM across stream boundary": Buffer.from(" ".repeat(65530) + Buffer.from(pem).toString("base64")),
  };
  for (const [name, contents] of Object.entries(fixtures)) {
    await t.test(`${name}: bundle text`, async (t) => {
      const result = await created(t);
      await writeFile(path.join(result.output, "compose.yml"), contents, { mode: 0o600 });
      await checksums(result.output);
      const verification = run(result.verifyArgs);
      fails(verification, /private key material/);
      assert.ok(!verification.stderr.includes(der.toString("base64")), "no key bytes in errors");
    });
    await t.test(`${name}: image layer`, async (t) => {
      const malicious = await fixture(t, { layerFiles: { "opt/data.dat": contents } });
      fails(run(malicious.createArgs), /private key material/);
      const result = await created(t);
      await replaceBundleImage(result, malicious);
      fails(run(result.verifyArgs), /private key material/);
    });
  }
  const publicDer = ec.publicKey.export({ type: "spki", format: "der" });
  const result = await created(t, { layerFiles: { "opt/public.dat": publicDer, "opt/public.txt": publicDer.toString("base64") } });
  succeeds(run(result.verifyArgs));
});

test("ASCII whitespace FF/VT cannot hide base64 DER/PEM across stream chunks", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  for (const format of ["der", "pem"]) {
    const encoded = Buffer.from(privateKey.export({ type: "pkcs8", format })).toString("base64");
    for (const [label, separator] of [["FF", "\f"], ["VT", "\v"]]) {
      // In the bundle file, the first separator is byte 65,536: it and the
      // following base64 data must join the preceding chunk's partial prefix.
      const contents = Buffer.from(" ".repeat(65532) + encoded.match(/.{1,4}/g).join(separator));
      await t.test(`${format}/${label}: bundle stream boundary`, async (t) => {
        const result = await created(t);
        await writeFile(path.join(result.output, "compose.yml"), contents, { mode: 0o600 });
        await checksums(result.output);
        fails(run(result.verifyArgs), /private key material/);
      });
      await t.test(`${format}/${label}: image layer`, async (t) => {
        const malicious = await fixture(t, { layerFiles: { "opt/data.dat": contents } });
        fails(run(malicious.createArgs), /private key material/);
        const result = await created(t);
        await replaceBundleImage(result, malicious);
        fails(run(result.verifyArgs), /private key material/);
      });
    }
  }
  const publicBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64").match(/.{1,4}/g).join("\f\v");
  const publicBundle = await created(t, { layerFiles: { "opt/public.txt": publicBase64 } });
  succeeds(run(publicBundle.verifyArgs));
});

test("manifest states the bounded private-material scan profile and refuses a weakened claim", async (t) => {
  const result = await created(t);
  const manifest = JSON.parse(await readFile(path.join(result.output, "release-manifest.json"), "utf8"));
  assert.deepEqual(manifest.privateMaterialScan, {
    profile: "led-control-private-material/v1",
    scope: "bundle-files-and-all-uncompressed-image-layer-bytes",
    pem: "literal-private-key-markers",
    der: "node-crypto-pkcs1-pkcs8-sec1-and-passphrase-required-pkcs8",
    base64: "one-standard-base64-layer-with-ascii-whitespace",
    maxDerBytes: 65536,
    maxBase64CandidateChars: 131072,
    oversizedRecognizedCandidates: "reject",
    notCovered: ["general-secrets", "decryption", "decompression", "other-encodings-or-obfuscation"],
  });
  await updateJson(result.output, "release-manifest.json", (value) => { value.privateMaterialScan = { profile: "none" }; });
  fails(run(result.verifyArgs), /private-material scan profile/);
});

test("appliance.env serializes and verifies strict numeric test-mode values", async (t) => {
  for (const [testMode, expected] of [[false, "0"], [true, "1"]]) {
    const result = await created(t, { testMode });
    const filename = path.join(result.output, "appliance.env");
    const original = await readFile(filename, "utf8");
    assert.match(original, new RegExp(`^GATEWAY_RELEASE_TEST_MODE=${expected}$`, "m"));
    const verify = [...result.verifyArgs, ...(testMode ? ["--allow-test-mode"] : [])];
    succeeds(run(verify));
    for (const bad of ["true", "false", "00", "01", "2", "", testMode ? "0" : "1"]) {
      await writeFile(filename, original.replace(/^GATEWAY_RELEASE_TEST_MODE=.*$/m, `GATEWAY_RELEASE_TEST_MODE=${bad}`));
      await checksums(result.output);
      fails(run(verify), /appliance.env/);
    }
  }
});

test("checked-in policy fixes the exact platform, BlueZ and firmware compatibility", async () => {
  assert.deepEqual(JSON.parse(await readFile(path.join(repository, "apps/gateway/release-policy.json"), "utf8")), policy);
});

test("create binds a closed checksum set, shell metadata and SPDX OS/Node inventory to the full commit", async (t) => {
  const result = await created(t);
  const manifest = JSON.parse(await readFile(path.join(result.output, "release-manifest.json"), "utf8"));
  assert.equal(manifest.schema, policy.schema);
  assert.equal(manifest.gitCommit, result.commit);
  assert.match(manifest.gitCommit, /^[a-f0-9]{40}$/);
  assert.equal(manifest.gitCommitTimestamp, "2026-09-12T00:00:00.000Z");
  assert.equal(manifest.gatewayVersion, "0.1.0");
  assert.equal(manifest.lockSha256, hash("lockfileVersion: '9.0'\n"));
  assert.equal(manifest.platform, "linux/arm64");
  assert.equal(manifest.testMode, false);
  assert.equal(manifest.image.configDigest, result.configDigest);
  assert.deepEqual(manifest.bluez, policy.bluez);
  assert.deepEqual(manifest.firmwareCompatibility, policy.firmwareCompatibility);
  const files = await regularFiles(result.output);
  assert.deepEqual(files, ["appliance.env", "checksums.sha256", "compose.yml", "docker/seccomp-bluez-mesh.json", "gateway-image-linux-arm64.tar", "release-manifest.json", "sbom.spdx.json"]);
  const checksumLines = (await readFile(path.join(result.output, "checksums.sha256"), "utf8")).trim().split("\n");
  assert.deepEqual(checksumLines.map((line) => line.slice(66)), files.filter((file) => file !== "checksums.sha256"));
  for (const line of checksumLines) assert.equal(line.slice(0, 64), hash(await readFile(path.join(result.output, line.slice(66)))));
  const sbom = JSON.parse(await readFile(path.join(result.output, "sbom.spdx.json"), "utf8"));
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.dataLicense, "CC0-1.0");
  assert.ok(sbom.documentNamespace.includes(result.commit));
  assert.ok(sbom.packages.some((item) => item.name === "libc6" && item.versionInfo === "2.36-9+deb12u10"));
  assert.ok(sbom.packages.some((item) => item.name === "mqtt" && item.versionInfo === "5.15.2"));
  assert.ok(sbom.packages.some((item) => item.name === "node" && item.versionInfo === "22.20.0"));
  assert.ok(sbom.packages.some((item) => item.name === "bluez" && item.checksums[0].checksumValue === policy.bluez.sourceSha256));
  assert.ok(sbom.relationships.some((item) => item.spdxElementId === "SPDXRef-DOCUMENT" && item.relationshipType === "DESCRIBES"));
  const ids = new Set(sbom.packages.map((item) => item.SPDXID));
  assert.equal(ids.size, sbom.packages.length);
  assert.ok(sbom.relationships.filter((item) => item.relationshipType === "CONTAINS").every((item) => ids.has(item.relatedSpdxElement)));
  const env = await readFile(path.join(result.output, "appliance.env"), "utf8");
  assert.match(env, new RegExp(`^GATEWAY_GIT_COMMIT=${result.commit}$`, "m"));
  assert.match(env, /^GATEWAY_RELEASE_TEST_MODE=0$/m);
  assert.match(env, /^GATEWAY_IMAGE_CONFIG_DIGEST=sha256:[a-f0-9]{64}$/m);
  succeeds(run([...result.verifyArgs, "--expected-commit", result.commit]));
  fails(run([...result.verifyArgs, "--expected-commit", "b".repeat(40)]), /expected source commit mismatch/);
});

test("create is deterministic and refuses to overwrite an existing release directory", async (t) => {
  const result = await created(t);
  const other = path.join(result.directory, "second-bundle");
  const args = [...result.createArgs];
  args[args.indexOf("--output") + 1] = other;
  succeeds(run(args));
  for (const file of await regularFiles(result.output)) assert.deepEqual(await readFile(path.join(result.output, file)), await readFile(path.join(other, file)));
  const before = await readFile(path.join(result.output, "checksums.sha256"));
  fails(run(result.createArgs), /already exists/);
  assert.deepEqual(await readFile(path.join(result.output, "checksums.sha256")), before);
});

test("CI platform override is explicit, test-only and rejected by default verification", async (t) => {
  const result = await created(t, { platform: "linux/amd64", testMode: true });
  const manifest = JSON.parse(await readFile(path.join(result.output, "release-manifest.json"), "utf8"));
  assert.equal(manifest.platform, "linux/amd64");
  assert.equal(manifest.testMode, true);
  fails(run(result.verifyArgs), /test-mode/);
  succeeds(run([...result.verifyArgs, "--allow-test-mode"]));
  const forbidden = await fixture(t, { platform: "linux/amd64" });
  fails(run(forbidden.createArgs), /platform override.*test-mode/);
});

test("create refuses dirty source and mismatched image provenance before producing a bundle", async (t) => {
  const dirty = await fixture(t);
  await writeFile(path.join(dirty.source, "untracked.txt"), "dirty");
  fails(run(dirty.createArgs), /clean Git checkout/);
  await assert.rejects(lstat(dirty.output), { code: "ENOENT" });
  for (const [label, replacement] of [["org.opencontainers.image.revision", "a".repeat(12)], ["org.opencontainers.image.version", "9.9.9"],
    ["org.opencontainers.image.source", "https://example.invalid/other"], ["com.led-control.lock-sha256", "b".repeat(64)],
    ["com.led-control.bluez.source-sha256", "c".repeat(64)], ["com.led-control.firmware-compatibility", "{}"]]) {
    const result = await fixture(t, { mutateLabels: (labels) => { labels[label] = replacement; } });
    fails(run(result.createArgs), /image label/);
  }
  const digest = await fixture(t, { mutateInspect: (image) => { image.Id = `sha256:${"a".repeat(64)}`; } });
  fails(run(digest.createArgs), /config digest/);
});

test("actual verify rejects extra, missing, tampered, symlink and special files", async (t) => {
  const mutations = {
    extra: async (output) => { await writeFile(path.join(output, "extra.txt"), "extra"); await checksums(output); },
    missing: async (output) => { await rm(path.join(output, "compose.yml")); await checksums(output); },
    tampered: async (output) => writeFile(path.join(output, "compose.yml"), "tampered\n"),
    symlink: async (output) => { await rm(path.join(output, "compose.yml")); await symlink("release-manifest.json", path.join(output, "compose.yml")); },
    fifo: async (output) => { await rm(path.join(output, "compose.yml")); assert.equal(spawnSync("mkfifo", [path.join(output, "compose.yml")]).status, 0); },
    hardlink: async (output) => { await rm(path.join(output, "compose.yml")); await link(path.join(output, "appliance.env"), path.join(output, "compose.yml")); },
    directory: async (output) => mkdir(path.join(output, "unexpected-directory")),
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async (t) => {
    const result = await created(t);
    await mutate(result.output);
    fails(run(result.verifyArgs));
  });
});

test("actual verify rejects unsafe or ambiguous checksum paths before reading their targets", async (t) => {
  for (const unsafe of ["../outside", "/etc/passwd", "docker/../compose.yml", "docker//profile.json", "a\\b", "./compose.yml"]) await t.test(unsafe, async (t) => {
    const result = await created(t);
    await writeFile(path.join(result.output, "checksums.sha256"), `${"a".repeat(64)}  ${unsafe}\n`);
    fails(run(result.verifyArgs), /unsafe|checksum/);
  });
  const duplicate = await created(t);
  const checksum = await readFile(path.join(duplicate.output, "checksums.sha256"), "utf8");
  await writeFile(path.join(duplicate.output, "checksums.sha256"), checksum + checksum.split("\n")[0] + "\n");
  fails(run(duplicate.verifyArgs), /duplicate|checksum/);
});

test("actual verify rejects secret filenames and PEM content even with recomputed checksums", async (t) => {
  for (const filename of [".env.appliance", "device.key", "private-key.pem", "id_rsa", "server.p12"]) await t.test(filename, async (t) => {
    const result = await created(t);
    await writeFile(path.join(result.output, filename), "not a real key");
    await checksums(result.output);
    fails(run(result.verifyArgs), /secret filename/);
  });
  for (const kind of ["PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY"]) await t.test(kind, async (t) => {
    const result = await created(t);
    await writeFile(path.join(result.output, "compose.yml"), `-----BEGIN ${kind}-----\nsynthetic-not-a-key\n-----END ${kind}-----\n`);
    await checksums(result.output);
    fails(run(result.verifyArgs), /private key material/);
  });
});

test("actual verify rejects forged policy/source/SBOM/env even after checksum regeneration", async (t) => {
  for (const [name, file, mutate] of [
    ["schema", "release-manifest.json", (value) => { value.schema = "other/v1"; }],
    ["policy", "release-manifest.json", (value) => { value.firmwareCompatibility.dimmingCommandWire = 1; }],
    ["commit", "release-manifest.json", (value) => { value.gitCommit = "a".repeat(12); }],
    ["platform", "release-manifest.json", (value) => { value.platform = "linux/amd64"; }],
    ["spdx inventory", "sbom.spdx.json", (value) => { value.packages = []; }],
    ["unknown key", "release-manifest.json", (value) => { value.secret = "extra"; }],
  ]) await t.test(name, async (t) => {
    const result = await created(t);
    await updateJson(result.output, file, mutate);
    fails(run(result.verifyArgs));
  });
  const injected = await created(t);
  await writeFile(path.join(injected.output, "appliance.env"), "GATEWAY_IMAGE_TAG=$(touch /tmp/not-executed)\n");
  await checksums(injected.output);
  fails(run(injected.verifyArgs), /appliance.env/);
  const duplicate = await created(t);
  const file = path.join(duplicate.output, "release-manifest.json");
  await writeFile(file, (await readFile(file, "utf8")).replace('"schema":', '"schema":"ignored", "schema":'));
  await checksums(duplicate.output);
  fails(run(duplicate.verifyArgs), /canonical JSON|duplicate JSON key/);
  fails(run(injected.verifyArgs.concat("--expected-commit", "b".repeat(40))));
});

test("archive layers cannot hide secret filenames or PEM data and inventory cannot be fabricated", async (t) => {
  for (const layerFiles of [{ "etc/device.key": "synthetic-not-a-key" }, { "opt/.env.appliance": "GATEWAY_ID=example" },
    { "opt/value.txt": "-----BEGIN ENCRYPTED PRIVATE KEY-----\nsynthetic-not-a-key" }]) {
    const result = await fixture(t, { layerFiles });
    fails(run(result.createArgs), /secret filename|private key material/);
  }
  const empty = structuredClone(inventory);
  empty.os.packages = [];
  fails(run((await fixture(t, { inventory: empty })).createArgs), /OS.*inventory/);
  const mismatch = await fixture(t);
  const supplied = path.join(mismatch.directory, "inventory.json");
  await writeFile(supplied, canonical({ ...inventory, node: { ...inventory.node, packages: [] } }));
  fails(run(mismatch.createArgs), /inventory/);
});

test("OS public CA PEM files remain valid while private-key PEM filenames are refused", async (t) => {
  const certificate = await created(t, { layerFiles: { "etc/ssl/certs/public-ca.pem": "-----BEGIN CERTIFICATE-----\nsynthetic-public-certificate" } });
  succeeds(run(certificate.verifyArgs));
  const privateKey = await fixture(t, { layerFiles: { "opt/gateway-key.pem": "synthetic-not-a-key" } });
  fails(run(privateKey.createArgs), /secret filename/);
});

test("JSON errors never echo input material and duplicate Docker metadata keys fail closed", async (t) => {
  const result = await fixture(t);
  const filename = path.join(result.directory, "inspect.json");
  await writeFile(filename, "sensitive-canary-value-not-json");
  const malformed = run(result.createArgs);
  fails(malformed, /invalid JSON/);
  assert.doesNotMatch(malformed.stderr, /sensitive-canary/);
  const duplicate = await fixture(t);
  const inspectFile = path.join(duplicate.directory, "inspect.json");
  await writeFile(inspectFile, (await readFile(inspectFile, "utf8")).replace('"Id":', '"Id":"ignored", "Id":'));
  fails(run(duplicate.createArgs), /duplicate JSON key/);
});

test("SPDX includes global Node packages shipped by the Node base image", async (t) => {
  const complete = structuredClone(inventory);
  complete.node.packages.push({ name: "npm", version: "10.9.3", location: "global_node_modules/npm", license: "Artistic-2.0" });
  const result = await created(t, { inventory: complete });
  const sbom = JSON.parse(await readFile(path.join(result.output, "sbom.spdx.json"), "utf8"));
  assert.ok(sbom.packages.some((item) => item.name === "npm" && item.sourceInfo.includes("global_node_modules/npm")));
  succeeds(run(result.verifyArgs));
});

test("actual build shell creates verifiable default/CI bundles through a fixture Docker boundary", async (t) => {
  for (const [testMode, oci] of [[false, false], [true, false], [true, true]]) await t.test(oci ? "Docker 29 descriptor naming" : testMode ? "explicit CI override" : "default ARM64", async (t) => {
    const result = await fixture(t, { withBuildScript: true, testMode, oci, platform: testMode ? "linux/amd64" : "linux/arm64" });
    const bin = path.join(result.directory, "bin");
    await mkdir(bin);
    const shim = path.join(bin, "docker");
    await writeFile(shim, `#!/usr/bin/env bash\nset -euo pipefail\ncase "$1 $2" in
  'buildx version') printf 'fixture buildx\\n' ;;
  'buildx build') printf '%s\\n' "$@" > "$FIXTURE_DOCKER_LOG" ;;
  'image save') cp "$FIXTURE_IMAGE_ARCHIVE" "$5" ;;
  'image inspect') cat "$FIXTURE_IMAGE_INSPECT" ;;
  'run --rm') cat "$FIXTURE_IMAGE_INVENTORY" ;;
  *) exit 91 ;;
esac\n`, { mode: 0o755 });
    const output = path.join(result.directory, "build-output");
    const log = path.join(result.directory, "docker-argv.log");
    const build = spawnSync("bash", [path.join(result.source, "scripts/gateway-appliance-build.sh")], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GATEWAY_APPLIANCE_OUTPUT_DIR: output,
        GATEWAY_IMAGE_REPOSITORY: "led-control-gateway", GATEWAY_IMAGE_TAG: result.commit,
        GATEWAY_RELEASE_TEST_MODE: testMode ? "1" : "0", GATEWAY_RELEASE_PLATFORM: testMode ? "linux/amd64" : "linux/arm64",
        FIXTURE_IMAGE_ARCHIVE: result.archive, FIXTURE_IMAGE_INSPECT: path.join(result.directory, "inspect.json"),
        FIXTURE_IMAGE_INVENTORY: path.join(result.directory, "inventory.json"), FIXTURE_DOCKER_LOG: log },
    });
    succeeds(build);
    const releases = await readdir(output);
    assert.equal(releases.length, 1, "temporary image inputs must be cleaned after the build");
    assert.equal(releases[0], JSON.parse(await readFile(path.join(output, releases[0], "release-manifest.json"), "utf8")).releaseId);
    const args = await readFile(log, "utf8");
    assert.match(args, new RegExp(`org.opencontainers.image.revision=${result.commit}`));
    assert.match(args, new RegExp(`--platform\\nlinux/${testMode ? "amd64" : "arm64"}`));
    const verify = ["verify", "--bundle", path.join(output, releases[0]), "--policy", path.join(result.source, "apps/gateway/release-policy.json")];
    if (testMode) fails(run(verify), /test-mode/);
    succeeds(run([...verify, ...(testMode ? ["--allow-test-mode"] : [])]));
  });
});

test("create and verify reject symlink roots and unknown CLI options", async (t) => {
  const result = await created(t);
  const linked = path.join(result.directory, "linked");
  await symlink(result.output, linked);
  fails(run(["verify", "--bundle", linked]), /symlink|directory/);
  const symlinkArchive = await fixture(t);
  await chmod(symlinkArchive.archive, 0o600);
  await symlink(symlinkArchive.archive, symlinkArchive.archive + ".link");
  const args = [...symlinkArchive.createArgs];
  args[args.indexOf("--image-archive") + 1] += ".link";
  fails(run(args), /regular file|symlink/);
  fails(run([...result.verifyArgs, "--ignore-checksum"]), /unknown option/);
});
