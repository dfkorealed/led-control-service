import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkServerIdentity, connect, createServer } from "node:tls";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const issue = join(root, "scripts", "pki", "issue-lab-service-cert.sh");
const mosquittoConfig = join(root, "infra", "mosquitto.production-tls.conf");

function runOpenSsl(args, cwd) {
  return execFileSync("openssl", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function createEcdsaCertificateAuthority(directory) {
  const caDirectory = join(directory, "fake-vault-ca");
  mkdirSync(join(caDirectory, "newcerts"), { recursive: true });
  writeFileSync(join(caDirectory, "index.txt"), "");
  writeFileSync(join(caDirectory, "serial"), "1000\n");
  writeFileSync(join(caDirectory, "crlnumber"), "1000\n");
  runOpenSsl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", "ca.key"], caDirectory);
  runOpenSsl([
    "req", "-x509", "-new", "-sha256", "-days", "1", "-key", "ca.key", "-out", "ca.crt", "-subj", "/CN=fake-vault-ca",
    "-addext", "basicConstraints=critical,CA:true", "-addext", "keyUsage=critical,keyCertSign,cRLSign"
  ], caDirectory);
  const config = join(caDirectory, "openssl.cnf");
  writeFileSync(config, [
    "[ ca ]", "default_ca = CA_default", "[ CA_default ]", `dir = ${caDirectory}`,
    "database = $dir/index.txt", "new_certs_dir = $dir/newcerts", "certificate = $dir/ca.crt", "private_key = $dir/ca.key",
    "serial = $dir/serial", "crlnumber = $dir/crlnumber", "default_md = sha256", "default_days = 1", "default_crl_days = 1",
    "policy = policy_any", "copy_extensions = copy", "x509_extensions = leaf_extensions", "unique_subject = no",
    "[ policy_any ]", "commonName = supplied", "[ leaf_extensions ]", "basicConstraints = critical,CA:false",
    "keyUsage = critical,digitalSignature,keyEncipherment", "extendedKeyUsage = serverAuth,clientAuth",
    "subjectKeyIdentifier = hash", "authorityKeyIdentifier = keyid,issuer", ""
  ].join("\n"));
  return { directory: caDirectory, certificate: join(caDirectory, "ca.crt"), config, crl: join(caDirectory, "mqtt-client.crl") };
}

function createRevokedClientCertificate(ca) {
  runOpenSsl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", "revoked.key"], ca.directory);
  runOpenSsl(["req", "-new", "-key", "revoked.key", "-out", "revoked.csr", "-subj", "/CN=revoked-client"], ca.directory);
  runOpenSsl(["ca", "-batch", "-config", ca.config, "-in", "revoked.csr", "-out", "revoked.crt", "-notext"], ca.directory);
  runOpenSsl(["ca", "-config", ca.config, "-revoke", "revoked.crt"], ca.directory);
  runOpenSsl(["ca", "-config", ca.config, "-gencrl", "-out", ca.crl], ca.directory);
  return { certificate: join(ca.directory, "revoked.crt"), key: join(ca.directory, "revoked.key") };
}

function writeSigningVault(directory, ca) {
  const executable = join(directory, "vault");
  writeFileSync(executable, `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "status") {
  process.stdout.write('{"storage_type":"raft"}\\n');
} else if (args[0] === "read" && args[1] === "-field=certificate") {
  process.stdout.write(readFileSync(process.env.FAKE_VAULT_CA_CERT));
} else if (args[0] === "read" && args[1] === "-format=raw") {
  process.stdout.write(readFileSync(process.env.FAKE_VAULT_CRL));
} else if (args[0] === "write" && args[1] === "-field=certificate") {
  const csr = args.find((argument) => argument.startsWith("csr=@"));
  if (!csr) process.exit(2);
  process.stdout.write(execFileSync("openssl", ["ca", "-batch", "-config", process.env.FAKE_VAULT_CA_CONFIG, "-in", csr.slice(5), "-out", "/dev/stdout", "-notext"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
} else {
  process.exit(2);
}
`);
  chmodSync(executable, 0o755);
  return executable;
}

function runIssue(environment) {
  return execFileSync(issue, [], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"]
  });
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

test("Vault-issued LAN bundle enforces MQTT mTLS, CRL, DNS/IP SAN, and production Mosquitto paths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "led-lan-tls-"));
  let server;
  try {
    const ca = createEcdsaCertificateAuthority(directory);
    const revokedClient = createRevokedClientCertificate(ca);
    const vault = writeSigningVault(directory, ca);
    const bundle = join(directory, "bundle");
    const output = runIssue({
      VAULT_BIN: vault,
      VAULT_ADDR: "https://vault.internal:8200",
      PKI_ENV: "lab",
      LAB_API_DNS: "api.lan",
      LAB_API_IP: "192.0.2.9",
      LAB_MQTT_DNS: "mqtt.lan",
      LAB_MQTT_IP: "192.0.2.10",
      PKI_SERVICE_CERT_DIR: bundle,
      FAKE_VAULT_CA_CERT: ca.certificate,
      FAKE_VAULT_CA_CONFIG: ca.config,
      FAKE_VAULT_CRL: ca.crl
    });
    assert.match(output, /Public service certificate bundle is ready/);
    for (const name of ["mqtt-server.crt", "mqtt-server.key", "mqtt-ca.crt", "api-mqtt-client.crt", "api-mqtt-client.key", "mqtt-client.crl", "device-ca.crt", "device.crl"]) {
      assert.match(readFileSync(join(bundle, name), "utf8"), /-----BEGIN/);
    }

    assert.match(runOpenSsl(["verify", "-CAfile", join(bundle, "mqtt-ca.crt"), join(bundle, "mqtt-server.crt")], directory), /OK/);
    assert.match(runOpenSsl(["verify", "-CAfile", join(bundle, "mqtt-ca.crt"), join(bundle, "api-mqtt-client.crt")], directory), /OK/);
    assert.match(runOpenSsl(["crl", "-in", join(bundle, "mqtt-client.crl"), "-noout", "-text"], directory), /Revoked Certificates/);
    assert.match(runOpenSsl(["crl", "-in", join(bundle, "device.crl"), "-noout", "-text"], directory), /Revoked Certificates/);
    const mqttCertificate = runOpenSsl(["x509", "-in", join(bundle, "mqtt-server.crt"), "-noout", "-text"], directory);
    const clientCertificate = runOpenSsl(["x509", "-in", join(bundle, "api-mqtt-client.crt"), "-noout", "-text"], directory);
    assert.match(mqttCertificate, /Public Key Algorithm: id-ecPublicKey/);
    assert.match(mqttCertificate, /DNS:mqtt\.lan, IP Address:192\.0\.2\.10/);
    assert.match(clientCertificate, /URI:spiffe:\/\/led-control\/mqtt\/api-service/);

    const config = readFileSync(mosquittoConfig, "utf8");
    for (const line of [
      "cafile /mosquitto/certs/mqtt-ca.crt", "certfile /mosquitto/certs/mqtt-server.crt", "keyfile /mosquitto/certs/mqtt-server.key",
      "crlfile /mosquitto/certs/mqtt-client.crl", "require_certificate true", "use_identity_as_username true"
    ]) assert.match(config, new RegExp(`^${line}$`, "m"));

    let acceptedConnections = 0;
    server = createServer({
      cert: readFileSync(join(bundle, "mqtt-server.crt")),
      key: readFileSync(join(bundle, "mqtt-server.key")),
      ca: readFileSync(join(bundle, "mqtt-ca.crt")),
      crl: readFileSync(join(bundle, "mqtt-client.crl")),
      requestCert: true,
      rejectUnauthorized: true
    }, (socket) => {
      acceptedConnections += 1;
      socket.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const validClient = {
      host: "127.0.0.1", port, servername: "mqtt.lan", ca: readFileSync(join(bundle, "mqtt-ca.crt")), rejectUnauthorized: true,
      cert: readFileSync(join(bundle, "api-mqtt-client.crt")), key: readFileSync(join(bundle, "api-mqtt-client.key"))
    };

    await connectTls(validClient);
    const revokedFailure = new Promise((resolve) => server.once("tlsClientError", resolve));
    await connectTls({ ...validClient, cert: readFileSync(revokedClient.certificate), key: readFileSync(revokedClient.key) });
    assert.match(String((await revokedFailure).message), /certificate revoked|socket hang up/i);
    await assert.rejects(
      connectTls({ ...validClient, servername: "wrong.mqtt.lan" }),
      /Hostname\/IP does not match certificate/i
    );
    await assert.rejects(
      connectTls({ ...validClient, checkServerIdentity: (_hostname, certificate) => checkServerIdentity("192.0.2.11", certificate) }),
      /Hostname\/IP does not match certificate/i
    );
    const untrustedCaDirectory = createEcdsaCertificateAuthority(join(directory, "untrusted"));
    await assert.rejects(
      connectTls({ ...validClient, ca: readFileSync(untrustedCaDirectory.certificate) }),
      /unable to verify the first certificate|self-signed certificate in certificate chain/i
    );
    assert.equal(acceptedConnections, 1);
  } finally {
    await new Promise((resolve) => server?.close(resolve) ?? resolve());
    rmSync(directory, { recursive: true, force: true });
  }
});
