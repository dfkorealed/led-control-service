import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts/gateway-bio-usb-preflight.sh");
// 실제 승인 descriptor: interface0, bulk IN82/OUT02, maxPacket32, 추가 interrupt81.
const descriptor = Buffer.from("12011001ff000208861a23550403000200010902270001010080f00904000003ff010200070582022000000705020220000007058103080001", "hex");

test("preflight rejects malformed descriptor/interface/bulk endpoint before returning deploy coordinates", async () => {
  await withFixture(async (fixture) => {
    const dir = await fixture.addUsb("1-1", { vendor: "1a86", product: "5523", bus: "1", device: "2", dev: "189:1" });
    for (const [offset, value] of [[8, 0], [29, 1], [38, 0x83], [40, 64], [45, 3]]) {
      const bad = Buffer.from(descriptor); bad[offset] = value;
      await writeFile(path.join(dir, "descriptors"), bad);
      const result = fixture.run();
      assert.notEqual(result.status, 0, `descriptor mutation ${offset} must fail`);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "BIO_USB_PREFLIGHT_DESCRIPTOR_INVALID\n");
    }
    await writeFile(path.join(dir, "descriptors"), descriptor.subarray(0, 41));
    assert.notEqual(fixture.run().status, 0);
  });
});

test("preflight는 exact-one BIO character device의 sysfs identity와 숫자 GID만 출력한다", async () => {
  await withFixture(async (fixture) => {
    await fixture.addUsb("1-1", { vendor: "1a86", product: "5523", bus: "2", device: "7", dev: "189:134" });
    const result = fixture.run({ stat: "character special file|bd|86|812" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      `GATEWAY_BIO_USB_DEVICE=${fixture.devRoot}/002/007\nGATEWAY_BIO_USB_GID=812\n`
    );
  });
});

test("preflight는 BIO 동글이 없거나 둘 이상이면 fail-closed 한다", async () => {
  await withFixture(async (fixture) => {
    assert.notEqual(fixture.run().status, 0);
    await fixture.addUsb("1-1", { vendor: "1a86", product: "5523", bus: "1", device: "2", dev: "189:1" });
    await fixture.addUsb("1-2", { vendor: "1A86", product: "5523", bus: "1", device: "3", dev: "189:2" });
    assert.notEqual(fixture.run().status, 0);
  });
});

test("preflight는 character device가 아니거나 sysfs dev 번호가 다른 node를 거부한다", async () => {
  await withFixture(async (fixture) => {
    await fixture.addUsb("1-1", { vendor: "1a86", product: "5523", bus: "1", device: "2", dev: "189:1" });

    assert.notEqual(fixture.run({ stat: "regular file|bd|1|812" }).status, 0);
    assert.notEqual(fixture.run({ stat: "character special file|bd|2|812" }).status, 0);
  });
});

test("preflight는 숫자가 아닌 device GID를 거부한다", async () => {
  await withFixture(async (fixture) => {
    await fixture.addUsb("1-1", { vendor: "1a86", product: "5523", bus: "1", device: "2", dev: "189:1" });
    assert.notEqual(fixture.run({ stat: "character special file|bd|1|not-a-gid" }).status, 0);
  });
});

test("preflight는 sysfs TOCTOU read 실패에 raw path를 노출하지 않는다", async () => {
  await withFixture(async (fixture) => {
    const deviceRoot = await fixture.addUsb("sensitive-device-name", {
      vendor: "1a86", product: "5523", bus: "1", device: "2", dev: "189:1"
    });
    await unlink(path.join(deviceRoot, "busnum"));
    const result = fixture.run();

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "BIO_USB_PREFLIGHT_SYSFS_READ_FAILED\n");
    assert.doesNotMatch(result.stderr, /sensitive-device-name|bio-usb-preflight-/);
  });
});

test("preflight는 stat 실패의 raw command/path stderr를 억제한다", async () => {
  await withFixture(async (fixture) => {
    await fixture.addUsb("sensitive-device-name", {
      vendor: "1a86", product: "5523", bus: "1", device: "2", dev: "189:1"
    });
    const result = fixture.run({ statFailure: true });

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "BIO_USB_PREFLIGHT_STAT_FAILED\n");
    assert.doesNotMatch(result.stderr, /sensitive-device-name|bio-usb-preflight-/);
  });
});

async function withFixture(callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "bio-usb-preflight-"));
  const sysfsRoot = path.join(fixtureRoot, "sysfs");
  const devRoot = path.join(fixtureRoot, "dev");
  const binRoot = path.join(fixtureRoot, "bin");
  await Promise.all([mkdir(sysfsRoot), mkdir(devRoot), mkdir(binRoot)]);
  const stat = path.join(binRoot, "stat");
  await writeFile(stat, [
    "#!/bin/sh",
    'if [ "${BIO_TEST_STAT_FAIL:-0}" = 1 ]; then',
    '  printf \'stat leaked args: %s\\n\' "$*" >&2',
    "  exit 9",
    "fi",
    'printf \'%s\\n\' "${BIO_TEST_STAT:-character special file|bd|1|812}"',
    ""
  ].join("\n"));
  await chmod(stat, 0o755);

  const fixture = {
    devRoot,
    async addUsb(name, { vendor, product, bus, device, dev }) {
      const deviceRoot = path.join(sysfsRoot, name);
      const nodeDirectory = path.join(devRoot, String(bus).padStart(3, "0"));
      await Promise.all([mkdir(deviceRoot), mkdir(nodeDirectory, { recursive: true })]);
      await Promise.all([
        writeFile(path.join(deviceRoot, "idVendor"), `${vendor}\n`),
        writeFile(path.join(deviceRoot, "idProduct"), `${product}\n`),
        writeFile(path.join(deviceRoot, "busnum"), `${bus}\n`),
        writeFile(path.join(deviceRoot, "devnum"), `${device}\n`),
        writeFile(path.join(deviceRoot, "dev"), `${dev}\n`),
        writeFile(path.join(deviceRoot, "descriptors"), descriptor),
        writeFile(path.join(nodeDirectory, String(device).padStart(3, "0")), "fixture")
      ]);
      return deviceRoot;
    },
    run({ stat: statOutput, statFailure = false } = {}) {
      return spawnSync(script, [], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binRoot}:${process.env.PATH}`,
          GATEWAY_BIO_USB_SYSFS_ROOT: sysfsRoot,
          GATEWAY_BIO_USB_DEV_ROOT: devRoot,
          BIO_TEST_STAT_FAIL: statFailure ? "1" : "0",
          ...(statOutput ? { BIO_TEST_STAT: statOutput } : {})
        }
      });
    }
  };

  try {
    await callback(fixture);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
