import { ServiceUnavailableException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { MfaCryptoService } from "./mfa-crypto.service";

describe("MfaCryptoService", () => {
  const previousKey = process.env.MFA_ENCRYPTION_KEY;

  afterEach(() => {
    if (previousKey === undefined) delete process.env.MFA_ENCRYPTION_KEY;
    else process.env.MFA_ENCRYPTION_KEY = previousKey;
  });

  it("round-trips a secret with AES-256-GCM without exposing plaintext", () => {
    process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const service = new MfaCryptoService();
    const encrypted = service.encrypt("JBSWY3DPEHPK3PXP");

    expect(encrypted).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encrypted).not.toContain("JBSWY3DPEHPK3PXP");
    expect(service.decrypt(encrypted)).toBe("JBSWY3DPEHPK3PXP");
  });

  it.each([undefined, "not-base64", Buffer.alloc(31).toString("base64")])(
    "fails closed when MFA_ENCRYPTION_KEY is invalid: %s",
    (key) => {
      if (key === undefined) delete process.env.MFA_ENCRYPTION_KEY;
      else process.env.MFA_ENCRYPTION_KEY = key;
      expect(() => new MfaCryptoService().encrypt("secret")).toThrow(ServiceUnavailableException);
    }
  );

  it("rejects tampered ciphertext", () => {
    process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const service = new MfaCryptoService();
    const encrypted = service.encrypt("secret");
    const parts = encrypted.split(".");
    const ciphertext = Buffer.from(parts[2], "base64url");
    ciphertext[0] ^= 1;
    parts[2] = ciphertext.toString("base64url");
    const tampered = parts.join(".");

    expect(() => service.decrypt(tampered)).toThrow(ServiceUnavailableException);
  });
});
