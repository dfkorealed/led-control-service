import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { DataRetentionService } from "./data-retention.service";
import { CommandDetailRetentionService } from "./command-detail-retention.service";

@Module({ imports: [PrismaModule], providers: [DataRetentionService, CommandDetailRetentionService] })
export class RetentionModule {}
