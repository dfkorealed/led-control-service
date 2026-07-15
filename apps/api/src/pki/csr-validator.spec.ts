import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { Pkcs10CertificateRequestGenerator } from "@peculiar/x509";
import { validateGatewayCsr } from "./csr-validator";

const nodeCrypto = webcrypto as unknown as Crypto;

describe("validateGatewayCsr", () => {
  it("verifies proof-of-possession and exports an ECDSA P-256 public key", async () => {
    const csrPem = await createCsr("P-256");

    const result = await validateGatewayCsr(csrPem);

    expect(result.publicKey.type).toBe("public");
    expect(result.publicKey.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });
  });

  it("rejects a CSR whose PKCS#10 signature was modified", async () => {
    const csrPem = tamperSignature(await createCsr("P-256"));

    await expect(validateGatewayCsr(csrPem)).rejects.toThrow("CSR proof-of-possession is invalid");
  });

  it("rejects an EC public key on a curve other than P-256", async () => {
    const csrPem = await createCsr("P-384");

    await expect(validateGatewayCsr(csrPem)).rejects.toThrow("CSR public key must be ECDSA P-256");
  });

  it("rejects malformed input without echoing the CSR", async () => {
    const csrPem = "-----BEGIN CERTIFICATE REQUEST-----\nSECRET-CSR\n-----END CERTIFICATE REQUEST-----";

    const error = await validateGatewayCsr(csrPem).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("CSR is invalid");
    expect(String(error)).not.toContain(csrPem);
    expect(String(error)).not.toContain("SECRET-CSR");
  });
});

async function createCsr(namedCurve: "P-256" | "P-384") {
  const hash = namedCurve === "P-256" ? "SHA-256" : "SHA-384";
  const keys = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve },
    false,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const csr = await Pkcs10CertificateRequestGenerator.create(
    {
      name: "CN=untrusted-subject",
      keys,
      signingAlgorithm: { name: "ECDSA", hash }
    },
    nodeCrypto
  );
  return csr.toString("pem");
}

function tamperSignature(csrPem: string) {
  const body = csrPem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const der = Buffer.from(body, "base64");
  der[der.length - 1] ^= 1;
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join("\n")}\n-----END CERTIFICATE REQUEST-----`;
}
