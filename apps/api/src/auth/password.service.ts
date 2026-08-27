import { BadRequestException, Injectable } from "@nestjs/common";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const PASSWORD_KEY_LENGTH = 64;

@Injectable()
export class PasswordService {
  async hash(password: string) {
    if (password.length < 8) throw new BadRequestException("Password must be at least 8 characters");
    const salt = randomBytes(16).toString("hex");
    const derivedKey = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
    return `scrypt$${salt}$${derivedKey.toString("hex")}`;
  }

  async verify(password: string, passwordHash: string) {
    const [algorithm, salt, storedKey] = passwordHash.split("$");
    if (algorithm !== "scrypt" || !salt || !storedKey) return false;
    const derivedKey = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
    const storedBuffer = Buffer.from(storedKey, "hex");
    return derivedKey.length === storedBuffer.length && timingSafeEqual(derivedKey, storedBuffer);
  }
}
