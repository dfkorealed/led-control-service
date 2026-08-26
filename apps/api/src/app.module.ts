import { Module } from "@nestjs/common";
import { AccessModule } from "./access/access.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { CommandsModule } from "./commands/commands.module";
import { EnergyModule } from "./energy/energy.module";
import { FloorEditorModule } from "./floor-editor/floor-editor.module";
import { FloorMapModule } from "./floor-map/floor-map.module";
import { FixturesModule } from "./fixtures/fixtures.module";
import { FixtureGroupsModule } from "./fixture-groups/fixture-groups.module";
import { GatewayOnboardingModule } from "./gateway-onboarding/gateway-onboarding.module";
import { MeshControlGroupModule } from "./mesh-control-groups/mesh-control-group.module";
import { PkiModule } from "./pki/pki.module";
import { PrismaModule } from "./prisma/prisma.module";
import { RegistrationModule } from "./registration/registration.module";
import { SetupModule } from "./setup/setup.module";
import { SitesModule } from "./sites/sites.module";

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    AccessModule,
    AuditModule,
    SitesModule,
    CommandsModule,
    EnergyModule,
    RegistrationModule,
    MeshControlGroupModule,
    SetupModule,
    FloorEditorModule,
    FloorMapModule,
    GatewayOnboardingModule,
    PkiModule,
    FixturesModule,
    FixtureGroupsModule
  ]
})
export class AppModule {}
