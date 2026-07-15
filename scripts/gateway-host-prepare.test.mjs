import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(projectRoot, "scripts/gateway-host-prepare.sh");

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "gateway-host-"));
  const bin = path.join(root, "bin");
  const modprobeDir = path.join(root, "etc/modprobe.d");
  await mkdir(bin, { recursive: true });
  await mkdir(modprobeDir, { recursive: true });
  await writeFile(path.join(modprobeDir, "rfkill_default.conf"), "options rfkill default_state=0\n");

  const commands = {
    uname: "#!/bin/sh\nprintf 'aarch64\\n'\n",
    docker: "#!/bin/sh\nexit 0\n",
    rfkill: "#!/bin/sh\nexit 0\n",
    systemctl: "#!/bin/sh\nexit 0\n",
    bluetoothctl: "#!/bin/sh\nprintf 'Controller 00:11:22:33:44:55 test [default]\\nPowered: yes\\n'\n"
  };
  for (const [name, body] of Object.entries(commands)) {
    const target = path.join(bin, name);
    await writeFile(target, body);
    await chmod(target, 0o755);
  }
  return { root, bin, config: path.join(modprobeDir, "rfkill_default.conf") };
}

function run(fixture, ...args) {
  return spawnSync("/bin/sh", [scriptPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      GATEWAY_HOST_ROOT: fixture.root,
      GATEWAY_HOST_SKIP_PACKAGE_INSTALL: "1"
    }
  });
}

test("check-only는 Bluetooth boot block을 발견하면 exit 2를 반환한다", async () => {
  const fixture = await createFixture();
  const result = run(fixture, "--check-only");

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /default_state=0/);
  assert.equal(await readFile(fixture.config, "utf8"), "options rfkill default_state=0\n");
});

test("apply는 Bluetooth boot policy를 원자적으로 허용 상태로 변경한다", async () => {
  const fixture = await createFixture();
  const result = run(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(fixture.config, "utf8"), "options rfkill default_state=1\n");
  assert.match(result.stdout, /Gateway host preparation complete/);
});

test("Bluetooth controller가 powered 상태가 아니면 실패한다", async () => {
  const fixture = await createFixture();
  await writeFile(path.join(fixture.bin, "bluetoothctl"), "#!/bin/sh\nprintf 'Powered: no\\n'\n");
  await chmod(path.join(fixture.bin, "bluetoothctl"), 0o755);

  const result = run(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Bluetooth controller is not powered/);
});
