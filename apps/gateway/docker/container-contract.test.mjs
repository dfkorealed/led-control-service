import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const dockerDir = import.meta.dirname;

test("appliance image는 고정된 BlueZ 5.82 소스를 검증해 빌드한다", async () => {
  const dockerfile = await readFile(path.join(dockerDir, "Dockerfile"), "utf8");

  assert.match(dockerfile, /ARG BLUEZ_VERSION=5\.82/);
  assert.match(dockerfile, /0739fa608a837967ee6d5572b43fb89946a938d1c6c26127158aaefd743a790b/);
  assert.match(dockerfile, /--enable-mesh/);
  assert.match(dockerfile, /bluetooth-meshd/);
  assert.match(dockerfile, /libglib2\.0-dev/);
  assert.match(dockerfile, /--disable-obex/);
  assert.match(dockerfile, /--disable-udev/);
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
  assert.match(entrypoint, /chmod 0700 \/var\/lib\/led-control/);
  expectOrder(entrypoint, "umask 077", "mkdir -p");
  expectOrder(entrypoint, "-S /run/dbus/system_bus_socket", "bluetooth-meshd --nodetach");
});

test("appliance runtime은 Debian Bookworm OpenSSL 3.0 계열을 설치하고 build-time에 확인한다", async () => {
  const dockerfile = await readFile(path.join(dockerDir, "Dockerfile"), "utf8");

  assert.match(dockerfile, /apt-get install[^;]*\bopenssl\b/s);
  assert.match(dockerfile, /openssl version[^\n]*OpenSSL 3\\\.0/);
  assert.match(dockerfile, /exact patch|snapshot/i);
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
});

function expectOrder(source, first, second) {
  assert.ok(source.indexOf(first) >= 0, `${first} is missing`);
  assert.ok(source.indexOf(second) > source.indexOf(first), `${second} must appear after ${first}`);
}
