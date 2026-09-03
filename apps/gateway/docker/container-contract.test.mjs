import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const dockerDir = import.meta.dirname;

test("appliance image는 고정된 BlueZ 5.82 소스를 검증해 빌드한다", async () => {
  const dockerfile = await readFile(path.join(dockerDir, "Dockerfile"), "utf8");

  assert.match(dockerfile, /ARG BLUEZ_VERSION=5\.82/);
  assert.match(dockerfile, /0739fa608a837967ee6d5572b43fb89946a938d1c6c26127158aaefd743a790b/);
  assert.match(dockerfile, /--enable-mesh/);
  assert.match(dockerfile, /bluetooth-meshd/);
  assert.match(dockerfile, /apt-get install[^;]*\blibbluetooth-dev\b/s);
  assert.match(dockerfile, /libglib2\.0-dev/);
  assert.match(dockerfile, /--disable-obex/);
  assert.match(dockerfile, /--disable-udev/);
});

test("로컬 AddNode는 Remote Provisioning 자기 우회를 건너뛰고 PB-ADV를 직접 사용한다", async () => {
  const dockerfile = await readFile(path.join(dockerDir, "Dockerfile"), "utf8");
  const patch = await readFile(path.join(dockerDir, "patches", "bluez-5.82-local-add-node-pb-adv.patch"), "utf8");

  assert.match(dockerfile, /COPY apps\/gateway\/docker\/patches\/bluez-5\.82-local-add-node-pb-adv\.patch \/tmp\//);
  assert.match(dockerfile, /patch -p1 < \/tmp\/bluez-5\.82-local-add-node-pb-adv\.patch/);
  assert.match(patch, /bool remote_server_requested = false;/);
  assert.match(patch, /remote_server_requested = true;/);
  assert.match(patch, /remote_server_requested \? server : 0/);
});

test("BlueZ AppKey 생성은 즉시 사용하고 재시작 후에도 복원되도록 로컬 노드 설정에 저장한다", async () => {
  const patch = await readFile(path.join(dockerDir, "patches", "bluez-5.82-local-add-node-pb-adv.patch"), "utf8");

  assert.match(patch, /#include "mesh\/appkey\.h"/);
  assert.match(patch, /appkey_key_add\(node_get_net\(node\), net_idx, app_idx,/);
  assert.match(patch, /keyring_get_app_key[\s\S]*appkey_key_add/);
  assert.match(patch, /if \(app_key\.net_idx != net_idx\)/);
  assert.doesNotMatch(patch, /^\+.*memcmp\(app_key\.old_key, new_key/m);
  assert.match(patch, /keyring_del_app_key\(node, app_idx\)/);
});

test("BlueZ generic HCI는 송신 burst마다 random address를 바꾸지 않는다", async () => {
  const patch = await readFile(path.join(dockerDir, "patches", "bluez-5.82-local-add-node-pb-adv.patch"), "utf8");

  assert.match(patch, /--- a\/mesh\/mesh-io-generic\.c/);
  assert.match(patch, /BCM4345C0 rejects LE Set Random Address while passive scanning remains[\s\S]*enabled/);
  assert.match(patch, /^-\s*bt_hci_send\(pvt->hci, BT_HCI_CMD_LE_SET_RANDOM_ADDRESS,/m);
});

test("appliance build context는 shared 패키지의 실제 build entry를 포함한다", async () => {
  const dockerfile = await readFile(path.join(dockerDir, "Dockerfile"), "utf8");

  assert.match(dockerfile, /FROM node:22-bookworm-slim AS app-builder[\s\S]*?apt-get install[^\n]*procps/);
  assert.match(dockerfile, /COPY packages\/automation-engine\/package\.json packages\/automation-engine\/package\.json/);
  assert.match(dockerfile, /COPY packages\/automation-engine\/src packages\/automation-engine\/src/);
  assert.match(dockerfile, /COPY packages\/automation-engine\/tsconfig\.json packages\/automation-engine\/tsconfig\.json/);
  assert.match(dockerfile, /COPY packages\/shared\/scripts packages\/shared\/scripts/);
  assert.match(dockerfile, /COPY packages\/shared\/tsconfig\.esm\.json packages\/shared\/tsconfig\.esm\.json/);
  assert.match(dockerfile, /pnpm --filter @led-control\/shared build/);
  assert.match(dockerfile, /pnpm --filter @led-control\/automation-engine build/);
});

test("appliance image는 bluetoothd 없이 배포판 kernel management btmgmt를 포함한다", async () => {
  const dockerfile = await readFile(path.join(dockerDir, "Dockerfile"), "utf8");

  assert.match(dockerfile, /FROM debian:bookworm-slim AS btmgmt-builder/);
  assert.match(dockerfile, /apt-get install[^;]*\bbluez\b/s);
  assert.match(dockerfile, /COPY --from=btmgmt-builder \/usr\/bin\/btmgmt \/usr\/local\/bin\/btmgmt/);
  assert.doesNotMatch(dockerfile, /bluetoothd/);
});

test("appliance runtime은 Node 22와 전용 non-root gateway 사용자를 사용한다", async () => {
  const dockerfile = await readFile(path.join(dockerDir, "Dockerfile"), "utf8");
  const entrypoint = await readFile(path.join(dockerDir, "entrypoint.sh"), "utf8");

  assert.match(dockerfile, /node:22-bookworm-slim/);
  assert.match(dockerfile, /useradd[^\n]+gateway/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/gateway-entrypoint"\]/);
  assert.match(entrypoint, /-S \/run\/dbus\/system_bus_socket/);
  assert.match(entrypoint, /^umask 077$/m);
  assert.match(entrypoint, /^chmod 0755 \/run\/dbus$/m);
  assert.match(entrypoint, /^umask 011$/m);
  assert.match(entrypoint, /chmod 0700 \/var\/lib\/led-control/);
  expectOrder(entrypoint, "umask 077", "mkdir -p");
  expectOrder(entrypoint, "chmod 0755 /run/dbus", "umask 011");
  expectOrder(entrypoint, "umask 011", "dbus-daemon --config-file");
  assert.match(entrypoint, /umask 011\ndbus-daemon[^\n]+\nDBUS_PID=\$!\numask 077/);
  expectOrder(entrypoint, "-S /run/dbus/system_bus_socket", "bluetooth-meshd --nodetach");
});

test("BlueZ 상세 로그는 명시적인 진단 플래그에서만 활성화된다", async () => {
  const entrypoint = await readFile(path.join(dockerDir, "entrypoint.sh"), "utf8");

  assert.match(entrypoint, /GATEWAY_BLUEZ_DEBUG:-0/);
  assert.match(entrypoint, /BLUEZ_DEBUG_ARGS="--debug --dbus-debug"/);
  assert.match(entrypoint, /bluetooth-meshd --nodetach --storage \/var\/lib\/bluetooth\/mesh .*\$BLUEZ_DEBUG_ARGS/);
});

test("전용 Raspberry Pi HCI는 검증된 generic raw-HCI 경로를 기본 사용한다", async () => {
  const entrypoint = await readFile(path.join(dockerDir, "entrypoint.sh"), "utf8");

  assert.match(entrypoint, /GATEWAY_BLUEZ_IO:-generic:hci0/);
  assert.match(entrypoint, /\^generic:hci\[0-9\]\+\$/);
  assert.match(entrypoint, /BLUEZ_IO_ARGS="--io \$BLUEZ_IO"/);
  assert.match(
    entrypoint,
    /bluetooth-meshd --nodetach --storage \/var\/lib\/bluetooth\/mesh \$BLUEZ_IO_ARGS \$BLUEZ_DEBUG_ARGS/
  );
  assert.match(entrypoint, /HCI_INDEX="\$\{BLUEZ_IO#generic:hci\}"/);
  assert.match(entrypoint, /timeout "\$\{GATEWAY_HCI_RESET_TIMEOUT_SECONDS:-5\}"\s+\\?\s*btmgmt --index "\$HCI_INDEX" power off/);
  assert.match(entrypoint, /\n\s*0\) ;;/);
  assert.match(entrypoint, /\n\s*124\)/);
  assert.match(entrypoint, /grep -q 'Set Powered complete'/);
  expectOrder(entrypoint, "timeout \"${GATEWAY_HCI_RESET_TIMEOUT_SECONDS:-5}\"", "bluetooth-meshd --nodetach");
});

test("appliance runtime은 Debian Bookworm OpenSSL 3.0 계열을 설치하고 build-time에 확인한다", async () => {
  const dockerfile = await readFile(path.join(dockerDir, "Dockerfile"), "utf8");
  const runtime = dockerfile.slice(dockerfile.indexOf("FROM node:22-bookworm-slim AS runtime"));

  assert.match(dockerfile, /apt-get install[^;]*\bopenssl\b/s);
  assert.match(dockerfile, /openssl version[^\n]*OpenSSL 3\\\.0/);
  assert.match(dockerfile, /exact patch|snapshot/i);
  assert.match(runtime, /apt-get install[^;]*\bcurl\b/s);
});

test("root healthcheck는 Mesh가 점유한 management socket을 재조회하지 않고 attach 상태를 검증한다", async () => {
  const healthcheck = await readFile(path.join(dockerDir, "healthcheck.sh"), "utf8");
  const healthcheckState = await readFile(path.join(dockerDir, "healthcheck-state.cjs"), "utf8");

  assert.match(healthcheck, /GATEWAY_BLUEZ_ADAPTER_PATH:-\/org\/bluez\/hci0/);
  assert.match(healthcheck, /HCI_NAME="\$\{BLUEZ_ADAPTER_PATH##\*\/\}"/);
  assert.match(healthcheck, /test -d "\/sys\/class\/bluetooth\/\$HCI_NAME"/);
  assert.doesNotMatch(healthcheck, /\/usr\/local\/bin\/btmgmt/);
  assert.match(healthcheck, /node \/usr\/local\/lib\/gateway-healthcheck-state\.cjs/);
  assert.doesNotMatch(healthcheck, /\/sys\/class\/bluetooth\/hci0\/(address|flags)/);
  assert.doesNotMatch(healthcheckState, /GATEWAY_HCI_POWERED/);
  assert.doesNotMatch(healthcheckState, /!health\.hciPowered/);
});

test("root healthcheck btmgmt verifier accepts only selected powered controllers", async () => {
  await assert.doesNotReject(checkBtmgmt("hci7", [
    "hci7: Primary controller",
    "\tcurrent settings: powered connectable ssp br/edr le"
  ].join("\n")));
  await assert.rejects(checkBtmgmt("hci7", [
    "hci7: Primary controller",
    "\tcurrent settings: connectable ssp br/edr le"
  ].join("\n")), /btmgmt check failed/);
  await assert.rejects(checkBtmgmt("hci7", "hci7:\n\tcurrent settings: powered"), /btmgmt check failed/);
  await assert.rejects(checkBtmgmt("hci7", "current settings: powered"), /btmgmt check failed/);
  await assert.rejects(checkBtmgmt("hci7", "hci6: Primary controller\n\tcurrent settings: powered"), /btmgmt check failed/);
});

test("image build context에 인증서나 private key를 복사하지 않는다", async () => {
  const dockerfile = await readFile(path.join(dockerDir, "Dockerfile"), "utf8");
  const dockerignore = await readFile(path.resolve(dockerDir, "../../../.dockerignore"), "utf8");

  assert.doesNotMatch(dockerfile, /COPY[^\n]*(certs|\.pem|\.key)/i);
  assert.match(dockerfile, /find \/tmp\/gateway-runtime\/node_modules[^\n]*'\*\.md' -delete/);
  assert.match(dockerignore, /\*\*\/certs/);
  assert.match(dockerignore, /\*\.key/);
  assert.match(dockerignore, /\.env/);
});

test("gateway D-Bus policy는 daemon 요청과 응답을 모두 최소 허용한다", async () => {
  const config = await readFile(path.join(dockerDir, "dbus-system.conf"), "utf8");
  assert.match(config, /allow user="root"/);
  assert.match(config, /allow user="gateway"/);
  assert.match(config, /send_destination="org\.freedesktop\.DBus"/);
  assert.match(config, /receive_sender="org\.freedesktop\.DBus"/);
  assert.match(config, /send_destination="org\.bluez\.mesh"/);
  assert.match(config, /receive_sender="org\.bluez\.mesh"/);
  assert.match(config, /send_type="method_return"\s+send_requested_reply="true"/);
  assert.match(config, /send_type="error"\s+send_requested_reply="true"/);
  assert.doesNotMatch(config, /send_requested_reply="false"/);
});

function expectOrder(source, first, second) {
  assert.ok(source.indexOf(first) >= 0, `${first} is missing`);
  assert.ok(source.indexOf(second) > source.indexOf(first), `${second} must appear after ${first}`);
}

function checkBtmgmt(controller, output) {
  const verifier = path.join(dockerDir, "btmgmt-powered.cjs");
  return new Promise((resolve, reject) => {
    const child = spawn("node", [verifier, controller]);
    child.stdin.end(output);
    child.on("error", (error) => reject(new Error(`btmgmt check failed: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`btmgmt check failed: exit ${code}`));
    });
  });
}
