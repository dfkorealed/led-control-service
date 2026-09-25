import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

interface MailTokens { accessToken: string; refreshToken: string }
interface EncryptedTokens { tokenCiphertext: string; tokenIv: string; tokenTag: string }
const associatedData = Buffer.from("kinda-landing-mail:v1");

export class LandingMailTokenCipher {
  private constructor(private readonly key: Buffer) {}

  static fromConfiguration(value: string | undefined): LandingMailTokenCipher | null {
    if (!value) return null;
    const key = Buffer.from(value, "base64");
    if (key.length !== 32 || key.toString("base64") !== value) return null;
    return new LandingMailTokenCipher(key);
  }

  encrypt(tokens: MailTokens): EncryptedTokens {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(associatedData);
    return {
      tokenCiphertext: Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]).toString("base64"),
      tokenIv: iv.toString("base64"),
      tokenTag: cipher.getAuthTag().toString("base64")
    };
  }

  decrypt(record: EncryptedTokens): MailTokens {
    const iv = Buffer.from(record.tokenIv, "base64");
    const tag = Buffer.from(record.tokenTag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid mail credential");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv, { authTagLength: 16 });
    decipher.setAAD(associatedData);
    decipher.setAuthTag(tag);
    const tokens = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(record.tokenCiphertext, "base64")), decipher.final()
    ]).toString("utf8")) as MailTokens;
    if (typeof tokens.accessToken !== "string" || !tokens.accessToken || typeof tokens.refreshToken !== "string" || !tokens.refreshToken) {
      throw new Error("Invalid mail credential");
    }
    return tokens;
  }
}
