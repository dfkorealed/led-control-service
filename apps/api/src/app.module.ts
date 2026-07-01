import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { SitesModule } from "./sites/sites.module";

@Module({
  imports: [PrismaModule, SitesModule]
})
export class AppModule {}
