import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { SessionAuthGuard } from "./session-auth.guard";

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, SessionAuthGuard],
  exports: [AuthService, PasswordService, SessionAuthGuard]
})
export class AuthModule {}
