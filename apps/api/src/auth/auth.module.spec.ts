import { Test } from "@nestjs/testing";
import { AuthModule } from "./auth.module";
import { AuthService } from "./auth.service";
import { AuthChallengeStore } from "./auth-challenge.store";
import { LoginRateLimitService } from "./login-rate-limit.service";
import { MfaCryptoService } from "./mfa-crypto.service";
import { TotpService } from "./totp.service";
import { MfaService } from "./mfa.service";

describe("AuthModule", () => {
  it("resolves AuthService through Nest dependency injection", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuthModule] }).compile();

    expect(moduleRef.get(AuthService)).toBeInstanceOf(AuthService);
    expect(moduleRef.get(LoginRateLimitService)).toBeInstanceOf(LoginRateLimitService);
    expect(moduleRef.get(AuthChallengeStore)).toBeInstanceOf(AuthChallengeStore);
    expect(moduleRef.get(MfaCryptoService)).toBeInstanceOf(MfaCryptoService);
    expect(moduleRef.get(TotpService)).toBeInstanceOf(TotpService);
    expect(moduleRef.get(MfaService)).toBeInstanceOf(MfaService);

    await moduleRef.close();
  });
});
