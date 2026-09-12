import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

@Injectable()
export class MfaCryptoService {
  encrypt(plaintext: string) {
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ["v1", iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw this.unavailable();
    }
  }

  decrypt(value: string) {
    try {
      const [version, ivValue, ciphertextValue, tagValue, extra] = value.split(".");
      if (version !== "v1" || !ivValue || !ciphertextValue || !tagValue || extra) throw new Error("invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(ivValue, "base64url"));
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, "base64url")),
        decipher.final()
      ]).toString("utf8");
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw this.unavailable();
    }
  }

  private key() {
    const encoded = process.env.MFA_ENCRYPTION_KEY?.trim();
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw this.unavailable();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded) throw this.unavailable();
    return key;
  }

  private unavailable() {
    return new ServiceUnavailableException({ code: "MFA_UNAVAILABLE", message: "MFA service is unavailable" });
  }
}
