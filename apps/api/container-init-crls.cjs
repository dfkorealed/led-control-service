const fs = require("node:fs");
const { createSecureContext } = require("node:tls");

function readCrl(filename) {
  if (!filename) throw new Error("Missing CRL path");
  const pem = fs.readFileSync(filename);
  createSecureContext({ crl: pem });
  return pem;
}

try {
  // Validate both read-only seeds before writing either output. Dynamic CRLs
  // are public revocation state, not private keys; only their volumes are RW.
  const entries = [
    [process.env.DEVICE_CRL_SEED_PATH, process.env.DEVICE_CRL_OUTPUT_PATH],
    [process.env.MQTT_CRL_SEED_PATH, process.env.MQTT_CRL_OUTPUT_PATH]
  ].map(([seed, destination]) => ({ pem: readCrl(seed), destination }));

  for (const { pem, destination } of entries) {
    let descriptor;
    try {
      descriptor = fs.openSync(destination, "wx", 0o644);
      fs.writeFileSync(descriptor, pem);
      fs.fsyncSync(descriptor);
    } catch (error) {
      // Restart must never replace a newer published CRL with its initial seed.
      // A partial/corrupt existing file fails validation instead of rolling back.
      if (error.code !== "EEXIST") throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    readCrl(destination);
  }
  console.log("CRL volumes initialized; existing revocation state preserved");
} catch {
  console.error("CRL seed initialization failed");
  process.exitCode = 1;
}
