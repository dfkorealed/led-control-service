import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

function runFunction(name, args, env = {}) {
  const command = `source "$1"; shift; ${name} "$@"`;
  return spawnSync("bash", ["-c", command, "test", library, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}
