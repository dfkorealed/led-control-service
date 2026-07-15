import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { EnergyController } from "./energy.controller";
import { EnergyService } from "./energy.service";

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [EnergyController],
  providers: [EnergyService]
})
export class EnergyModule {}
