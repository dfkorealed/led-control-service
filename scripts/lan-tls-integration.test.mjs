import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connect, createServer } from "node:tls";

function runOpenSsl(args, cwd) {
  return execFileSync("openssl", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function createEcdsaCertificateAuthority(directory, name) {
  runOpenSsl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`], directory);
  runOpenSsl([
    "req", "-x509", "-new", "-sha256", "-days", "1", "-key", `${name}.key`, "-out", `${name}.crt`,
    "-subj", `/CN=${name}`
  ], directory);
}

function createEcdsaServerCertificate(directory) {
  runOpenSsl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "mqtt.key"], directory);
  runOpenSsl(["req", "-new", "-key", "mqtt.key", "-out", "mqtt.csr", "-subj", "/CN=mqtt.lan"], directory);
  writeFileSync(join(directory, "mqtt.ext"), "subjectAltName=DNS:mqtt.lan,IP:192.0.2.10\nextendedKeyUsage=serverAuth\n");
  runOpenSsl([
    "x509", "-req", "-in", "mqtt.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "mqtt.crt",
    "-days", "1", "-sha256", "-extfile", "mqtt.ext"
  ], directory);
}

function connectTls(options) {
  return new Promise((resolve, reject) => {
    const socket = connect(options);
    socket.once("secureConnect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

test("ECDSA LAN TLS는 올바른 hostname만 신뢰하고 잘못된 hostname/IP/CA를 거부한다", async () => {
  const directory = mkdtempSync(join(tmpdir(), "led-lan-tls-"));
  let server;
  try {
    createEcdsaCertificateAuthority(directory, "ca");
    createEcdsaCertificateAuthority(directory, "untrusted-ca");
    createEcdsaServerCertificate(directory);
    const certificateText = runOpenSsl(["x509", "-in", "mqtt.crt", "-text", "-noout"], directory);
    assert.match(certificateText, /Public Key Algorithm: id-ecPublicKey/);
    assert.doesNotMatch(certificateText, /rsaEncryption/i);

    server = createServer({
      cert: readFileSync(join(directory, "mqtt.crt")),
      key: readFileSync(join(directory, "mqtt.key"))
    }, (socket) => socket.end());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const trustedCa = readFileSync(join(directory, "ca.crt"));

    await connectTls({ host: "127.0.0.1", port, servername: "mqtt.lan", ca: trustedCa, rejectUnauthorized: true });
    await assert.rejects(
      connectTls({ host: "127.0.0.1", port, servername: "wrong.mqtt.lan", ca: trustedCa, rejectUnauthorized: true }),
      /Hostname\/IP does not match certificate/i
    );
    await assert.rejects(
      connectTls({ host: "127.0.0.1", port, servername: "", ca: trustedCa, rejectUnauthorized: true }),
      /Hostname\/IP does not match certificate/i
    );
    await assert.rejects(
      connectTls({
        host: "127.0.0.1",
        port,
        servername: "mqtt.lan",
        ca: readFileSync(join(directory, "untrusted-ca.crt")),
        rejectUnauthorized: true
      }),
      /unable to verify the first certificate|self-signed certificate in certificate chain/i
    );
  } finally {
    await new Promise((resolve) => server?.close(resolve) ?? resolve());
    rmSync(directory, { recursive: true, force: true });
  }
});
