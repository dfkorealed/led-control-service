import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const library = path.join(root, "scripts/gateway-appliance-deploy-lib.sh");

test("dotenv parser는 spaces/quotes/comments를 읽되 command substitution을 실행하지 않는다", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "gateway-dotenv-"));
  const envFile = path.join(fixture, "appliance.env");
  const sentinel = path.join(fixture, "must-not-exist");
  await writeFile(envFile, [
    "# appliance settings",
    "GATEWAY_NAME=Raspberry Pi Gateway # operator label",
    'GATEWAY_DATA_DIR="/srv/led control/data" # protected data',
    `HOSTILE=$(touch ${sentinel})`,
    ""
  ].join("\n"));

  try {
    assert.equal(runFunction("read_compose_dotenv_value", [envFile, "GATEWAY_NAME"]).stdout, "Raspberry Pi Gateway\n");
    assert.equal(runFunction("read_compose_dotenv_value", [envFile, "GATEWAY_DATA_DIR"]).stdout, "/srv/led control/data\n");
    assert.equal(runFunction("read_compose_dotenv_value", [envFile, "HOSTILE"]).stdout, `$(touch ${sentinel})\n`);
    await assert.rejects(stat(sentinel));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rollback data helper는 sudo tar 뒤 소유권을 좁혀 0600 archive를 완성한다", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "gateway-rollback-"));
  const data = path.join(fixture, "protected-data");
  const rollback = path.join(fixture, "rollback.tgz");
  const bin = path.join(fixture, "bin");
  const log = path.join(fixture, "sudo.log");
  await Promise.all([
    mkdir(path.join(data, "gateway"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(data, "mesh"), { recursive: true, mode: 0o700 }),
    mkdir(bin)
  ]);
  await Promise.all([
    writeFile(path.join(data, "gateway/state.json"), "{}\n"),
    writeFile(path.join(data, "mesh/node.json"), "{}\n"),
    writeFile(path.join(bin, "sudo"), `#!/bin/sh\nprintf '%s\\n' "$1" >> "${log}"\nexec "$@"\n`)
  ]);
  await chmod(path.join(bin, "sudo"), 0o755);

  try {
    const result = runFunction("capture_gateway_data_snapshot", [data, rollback], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), ["tar", "chown"]);
    assert.equal((await stat(rollback)).mode & 0o777, 0o600);
    const listing = execFileSync("tar", ["-tzf", rollback], { encoding: "utf8" });
    assert.match(listing, /gateway\/state\.json/);
    assert.match(listing, /mesh\/node\.json/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("current BIO wrapper는 exported stale device보다 새 preflight 값을 Compose에 우선한다", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "gateway-replug-compose-"));
  try {
    await Promise.all([
      writeFile(path.join(fixture, "compose.yml"), await readFile(path.join(root, "apps/gateway/compose.raspberry-pi.yml"))),
      writeFile(path.join(fixture, "compose.bio-usb.yml"), await readFile(path.join(root, "apps/gateway/compose.bio-usb.yml"))),
      writeFile(path.join(fixture, ".env.appliance"), [
        "GATEWAY_BIO_USB_DEVICE=/dev/bus/usb/001/002",
        "GATEWAY_BIO_USB_GID=111",
        ""
      ].join("\n"))
    ]);
    const command = [
      "source \"$1\"",
      "cd \"$2\"",
      "run_with_current_bio_device /dev/bus/usb/003/004 222 docker compose --env-file .env.appliance -f compose.yml -f compose.bio-usb.yml config --format json"
    ].join("; ");
    const result = spawnSync("bash", ["-c", command, "test", library, fixture], {
      encoding: "utf8",
      env: {
        ...process.env,
        GATEWAY_BIO_USB_DEVICE: "/dev/bus/usb/001/002",
        GATEWAY_BIO_USB_GID: "111"
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const service = JSON.parse(result.stdout).services["gateway-appliance"];
    assert.deepEqual(service.devices, [{
      source: "/dev/bus/usb/003/004",
      target: "/dev/bus/usb/003/004",
      permissions: "rwm"
    }]);
    assert.deepEqual(service.group_add, ["222"]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rollback source는 stale shell이 아니라 공백과 중첩 보간을 반영한 Compose config를 따른다", async () => {
  const fixture = await createComposeFixture("rendered source with spaces", { interpolated: true });
  try {
    const renderedRoot = path.join(fixture, "rendered source with spaces", "data");
    await mkdir(path.join(renderedRoot, "gateway"), { recursive: true });
    await mkdir(path.join(renderedRoot, "mesh"), { recursive: true });
    await writeFile(path.join(fixture, ".env.appliance"), [
      `STORAGE_ROOT="${path.join(fixture, "rendered source with spaces")}"`,
      "GATEWAY_DATA_DIR=${STORAGE_ROOT}/data",
      "GATEWAY_ADAPTER=bluez",
      ""
    ].join("\n"));

    const result = runFunction("resolve_current_gateway_snapshot_root", [
      "bluez", ".env.appliance", "compose.yml", "compose.bio-usb.yml"
    ], {
      GATEWAY_DATA_DIR: path.join(fixture, "stale-shell"),
      STORAGE_ROOT: path.join(fixture, "stale-storage")
    }, fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${await realpath(renderedRoot)}\n`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rollback source는 Compose가 절대 경로로 해석한 relative bind를 사용한다", async () => {
  const fixture = await createComposeFixture("state", { relative: true });
  try {
    await mkdir(path.join(fixture, "state", "gateway"), { recursive: true });
    await mkdir(path.join(fixture, "state", "mesh"), { recursive: true });
    await writeFile(path.join(fixture, ".env.appliance"), "GATEWAY_ADAPTER=bluez\n");

    const result = runFunction("resolve_current_gateway_snapshot_root", [
      "bluez", ".env.appliance", "compose.yml", "compose.bio-usb.yml"
    ], {}, fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${await realpath(path.join(fixture, "state"))}\n`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rollback source는 현재 BlueZ/BIO compose file 집합을 구분한다", async () => {
  const fixture = await createComposeFixture("bluez-data");
  try {
    for (const rootName of ["bluez-data", "bio-data"]) {
      await mkdir(path.join(fixture, rootName, "gateway"), { recursive: true });
      await mkdir(path.join(fixture, rootName, "mesh"), { recursive: true });
    }
    await writeFile(path.join(fixture, ".env.appliance"), "GATEWAY_ADAPTER=bluez\n");
    await writeFile(path.join(fixture, "compose.bio-usb.yml"), composeSource(path.join(fixture, "bio-data")));

    const bluez = runFunction("resolve_current_gateway_snapshot_root", [
      "bluez", ".env.appliance", "compose.yml", "compose.bio-usb.yml"
    ], {}, fixture);
    const bio = runFunction("resolve_current_gateway_snapshot_root", [
      "bio-usb", ".env.appliance", "compose.yml", "compose.bio-usb.yml"
    ], {}, fixture);

    assert.equal(bluez.status, 0, bluez.stderr);
    assert.equal(bluez.stdout, `${await realpath(path.join(fixture, "bluez-data"))}\n`);
    assert.equal(bio.status, 0, bio.stderr);
    assert.equal(bio.stdout, `${await realpath(path.join(fixture, "bio-data"))}\n`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rollback source parser는 expected bind가 0개 또는 여러 개면 거부한다", () => {
  for (const volumes of [
    [{ type: "bind", source: "/srv/data/gateway", target: "/unrelated" }],
    [
      { type: "bind", source: "/srv/one/gateway", target: "/var/lib/led-control" },
      { type: "bind", source: "/srv/two/gateway", target: "/var/lib/led-control" },
      { type: "bind", source: "/srv/data/mesh", target: "/var/lib/bluetooth/mesh" }
    ]
  ]) {
    const result = runFunctionWithInput("extract_gateway_snapshot_sources", JSON.stringify({
      services: { "gateway-appliance": { volumes } }
    }, null, 2));
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "GATEWAY_ROLLBACK_MOUNT_INVALID\n");
  }
});

test("rollback source는 missing 또는 서로 다른 root의 ambiguous bind를 거부한다", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "gateway-source-invalid-"));
  try {
    const gateway = path.join(fixture, "one", "gateway");
    const unrelatedMesh = path.join(fixture, "two", "mesh");
    await mkdir(gateway, { recursive: true });
    await mkdir(unrelatedMesh, { recursive: true });

    const ambiguous = runFunction("canonical_gateway_snapshot_root", [gateway, unrelatedMesh]);
    const missing = runFunction("canonical_gateway_snapshot_root", [
      path.join(fixture, "missing", "gateway"), path.join(fixture, "missing", "mesh")
    ]);

    assert.notEqual(ambiguous.status, 0);
    assert.notEqual(missing.status, 0);
    assert.equal(ambiguous.stdout, "");
    assert.equal(missing.stdout, "");
    assert.equal(ambiguous.stderr, "GATEWAY_ROLLBACK_SOURCE_INVALID\n");
    assert.equal(missing.stderr, "GATEWAY_ROLLBACK_SOURCE_INVALID\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rollback snapshot은 실제 rendered source를 보관하고 unreadable source면 실패한다", async () => {
  const fixture = await createComposeFixture("actual-data");
  const bin = path.join(fixture, "bin");
  const archive = path.join(fixture, "rollback.tgz");
  const unreadableArchive = path.join(fixture, "unreadable.tgz");
  try {
    await mkdir(path.join(fixture, "actual-data", "gateway"), { recursive: true });
    await mkdir(path.join(fixture, "actual-data", "mesh"), { recursive: true });
    await mkdir(bin);
    await writeFile(path.join(fixture, "actual-data", "gateway", "rendered-marker"), "actual\n");
    await writeFile(path.join(fixture, "actual-data", "mesh", "mesh-marker"), "actual\n");
    await writeFile(path.join(fixture, ".env.appliance"), "GATEWAY_ADAPTER=bluez\n");
    await writeFile(path.join(bin, "sudo"), "#!/bin/sh\nexec \"$@\"\n");
    await chmod(path.join(bin, "sudo"), 0o755);

    const args = ["bluez", ".env.appliance", "compose.yml", "compose.bio-usb.yml"];
    const result = runResolvedSnapshot(archive, args, {
      PATH: `${bin}:${process.env.PATH}`
    }, fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }), /gateway\/rendered-marker/);

    await chmod(path.join(fixture, "actual-data", "gateway"), 0o000);
    const unreadable = runResolvedSnapshot(unreadableArchive, args, {
      PATH: `${bin}:${process.env.PATH}`
    }, fixture);
    assert.notEqual(unreadable.status, 0);
    assert.equal(unreadable.stderr, "GATEWAY_ROLLBACK_SNAPSHOT_FAILED\n");
    await assert.rejects(stat(unreadableArchive));
    await chmod(path.join(fixture, "actual-data", "gateway"), 0o700);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

function runFunction(name, args, env = {}, cwd = root) {
  const command = `source "$1"; shift; ${name} "$@"`;
  return spawnSync("bash", ["-c", command, "test", library, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd
  });
}

function runFunctionWithInput(name, input) {
  const command = `source "$1"; ${name}`;
  return spawnSync("bash", ["-c", command, "test", library], {
    encoding: "utf8",
    input
  });
}

function runResolvedSnapshot(archive, args, env, cwd) {
  const command = [
    'source "$1"',
    "shift",
    'archive="$1"',
    "shift",
    'snapshot_root=$(resolve_current_gateway_snapshot_root "$@") || exit 1',
    'capture_gateway_data_snapshot "$snapshot_root" "$archive" 2>/dev/null || { echo GATEWAY_ROLLBACK_SNAPSHOT_FAILED >&2; exit 1; }'
  ].join("; ");
  return spawnSync("bash", ["-c", command, "test", library, archive, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd
  });
}

async function createComposeFixture(dataRoot, { interpolated = false, relative = false } = {}) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "gateway-compose-source-"));
  const source = interpolated ? "${GATEWAY_DATA_DIR:?}" : relative ? `./${dataRoot}` : path.join(fixture, dataRoot);
  await writeFile(path.join(fixture, "compose.yml"), composeSource(source));
  await writeFile(path.join(fixture, "compose.bio-usb.yml"), "services: {}\n");
  return fixture;
}

function composeSource(source) {
  return [
    "services:",
    "  gateway-appliance:",
    "    image: busybox:latest",
    "    volumes:",
    `      - \"${source}/gateway:/var/lib/led-control\"`,
    `      - \"${source}/mesh:/var/lib/bluetooth/mesh\"`,
    ""
  ].join("\n");
}
