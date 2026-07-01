import { Module } from "@nestjs/common";
import { CommandsModule } from "./commands/commands.module";
import { PrismaModule } from "./prisma/prisma.module";
import { SitesModule } from "./sites/sites.module";

@Module({
  imports: [PrismaModule, SitesModule, CommandsModule]
})
export class AppModule {}
