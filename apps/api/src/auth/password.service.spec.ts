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
});
