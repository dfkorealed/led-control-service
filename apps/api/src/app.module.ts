import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { CommandsModule } from "./commands/commands.module";
import { EnergyModule } from "./energy/energy.module";
import { PrismaModule } from "./prisma/prisma.module";
import { SitesModule } from "./sites/sites.module";

@Module({
  imports: [PrismaModule, AuthModule, SitesModule, CommandsModule, EnergyModule]
})
export class AppModule {}
