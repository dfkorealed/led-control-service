import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { EnergyController } from "./energy.controller";
import { EnergyService } from "./energy.service";

@Module({
  imports: [PrismaModule],
  controllers: [EnergyController],
  providers: [EnergyService]
})
export class EnergyModule {}
