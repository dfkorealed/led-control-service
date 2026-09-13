import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { X509CrlGenerator } from "@peculiar/x509";

export async function createTestCrl(
  serialNumbers: string[],
  issuer = "CN=Test Intermediate",
  revision = 0,
  encodePositive = true
) {
  const signingKey = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const thisUpdate = new Date(Date.UTC(2026, 8, 12, 0, revision, 0));
  const crl = await X509CrlGenerator.create({
    issuer,
    thisUpdate,
    nextUpdate: new Date(thisUpdate.getTime() + 86_400_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    signingKey: signingKey.privateKey,
    entries: serialNumbers.map(serialNumber => ({
      serialNumber: encodePositive ? positiveDerSerial(serialNumber) : serialNumber,
      revocationDate: thisUpdate
    }))
  }, webcrypto as unknown as Crypto);

  // Vault emits the RFC 7468 "X509 CRL" label while @peculiar/x509 uses
  // the equivalent shorter "CRL" label for generated test material.
  return crl.toString("pem")
    .replace("-----BEGIN CRL-----", "-----BEGIN X509 CRL-----")
    .replace("-----END CRL-----", "-----END X509 CRL-----");
}

function positiveDerSerial(value: string) {
  const compact = value.replace(/[:-]/g, "").toUpperCase();
  const first = Number.parseInt(compact.slice(0, 2), 16);
  return first >= 0x80 ? `00${compact}` : compact;
}
