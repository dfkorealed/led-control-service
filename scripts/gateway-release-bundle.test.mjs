import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 30_000 });
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
    const data = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write("0", 156);
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
  const layer = tar({ "usr/local/share/gateway-release-inventory.json": inventoryBytes, ...options.layerFiles });
  const config = { architecture: platform.split("/")[1], os: "linux", config: { Labels: labels }, rootfs: { type: "layers", diff_ids: [`sha256:${hash(layer)}`] } };
  const configBytes = canonical(config);
  const configDigest = `sha256:${hash(configBytes)}`;
  const configName = `${hash(configBytes)}.json`;
  const imageTag = `${commit}${options.testMode ? "-test" : ""}`;
  const image = { Id: configDigest, Architecture: config.architecture, Os: config.os, Config: config.config, RepoTags: [`led-control-gateway:${imageTag}`] };
  options.mutateInspect?.(image);
  const archive = path.join(directory, "image.tar");
  await writeFile(archive, tar({ "manifest.json": JSON.stringify([{ Config: configName, RepoTags: [`led-control-gateway:${imageTag}`], Layers: ["layer/layer.tar"] }]), [configName]: configBytes, "layer/layer.tar": layer }));
  const inspect = path.join(directory, "inspect.json");
  const inventoryFile = path.join(directory, "inventory.json");
  await writeFile(inspect, JSON.stringify([image]));
  await writeFile(inventoryFile, inventoryBytes);
  const createArgs = ["create", "--source", source, "--image-archive", archive, "--image-inspect", inspect,
    "--inventory", inventoryFile, "--output", output, ...(options.testMode ? ["--test-mode"] : []),
    ...(options.platform ? ["--platform", platform] : [])];
  const verifyArgs = ["verify", "--bundle", output, "--policy", path.join(source, "apps/gateway/release-policy.json")];
  return { directory, source, output, commit, configDigest, createArgs, verifyArgs, archive, imageInventory, git };
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
  assert.match(env, /^GATEWAY_RELEASE_TEST_MODE=false$/m);
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
  for (const testMode of [false, true]) await t.test(testMode ? "explicit CI override" : "default ARM64", async (t) => {
    const result = await fixture(t, { withBuildScript: true, testMode, platform: testMode ? "linux/amd64" : "linux/arm64" });
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
