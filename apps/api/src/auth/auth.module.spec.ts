import { Test } from "@nestjs/testing";
import { AuthModule } from "./auth.module";
import { AuthService } from "./auth.service";

describe("AuthModule", () => {
  it("resolves AuthService through Nest dependency injection", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuthModule] }).compile();

    expect(moduleRef.get(AuthService)).toBeInstanceOf(AuthService);

    await moduleRef.close();
  });
});
