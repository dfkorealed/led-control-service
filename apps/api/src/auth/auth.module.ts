import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { PrismaModule } from "../prisma/prisma.module";
import { RedisModule } from "../redis/redis.module";
import { AuthChallengeStore } from "./auth-challenge.store";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { SessionAuthGuard } from "./session-auth.guard";
import { LoginRateLimitService } from "./login-rate-limit.service";
import { MfaCryptoService } from "./mfa-crypto.service";
import { TotpService } from "./totp.service";

@Module({
  imports: [PrismaModule, AuditModule, RedisModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionAuthGuard,
    LoginRateLimitService,
    MfaCryptoService,
    TotpService,
    AuthChallengeStore
  ],
  exports: [AuthService, PasswordService, SessionAuthGuard]
})
export class AuthModule {}
