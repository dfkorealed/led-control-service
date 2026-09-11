import { BadRequestException } from "@nestjs/common";
import { PasswordService } from "./password.service";

describe("PasswordService", () => {
  it("hashes a policy-compliant password and verifies it", async () => {
    const service = new PasswordService();
    const hash = await service.hash("correct horse battery staple");

    await expect(service.verify("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(service.verify("wrong password", hash)).resolves.toBe(false);
  });

  it("rejects passwords shorter than eight characters", async () => {
    await expect(new PasswordService().hash("short")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects passwords longer than 1024 characters", async () => {
    await expect(new PasswordService().hash("a".repeat(1025))).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects whitespace-only passwords", async () => {
    await expect(new PasswordService().hash("        ")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("preserves leading and trailing spaces in a non-blank password", async () => {
    const service = new PasswordService();
    const password = "  password with spaces  ";
    const hash = await service.hash(password);

    await expect(service.verify(password, hash)).resolves.toBe(true);
    await expect(service.verify(password.trim(), hash)).resolves.toBe(false);
  });
});
