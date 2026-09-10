import { Module } from "@nestjs/common";
import { FixtureIdentifyModule } from "./fixture-identify/fixture-identify.module";
import { AccessModule } from "./access/access.module";
import { AuditModule } from "./audit/audit.module";
import { AutomationModule } from "./automation/automation.module";
import { AuthModule } from "./auth/auth.module";
import { CommandsModule } from "./commands/commands.module";
import { EnergyModule } from "./energy/energy.module";
import { FloorEditorModule } from "./floor-editor/floor-editor.module";
import { FloorMapModule } from "./floor-map/floor-map.module";
import { FixturesModule } from "./fixtures/fixtures.module";
import { FixtureGroupsModule } from "./fixture-groups/fixture-groups.module";
import { GatewayOnboardingModule } from "./gateway-onboarding/gateway-onboarding.module";
import { MeshControlGroupModule } from "./mesh-control-groups/mesh-control-group.module";
import { OperatorSiteAdminsModule } from "./operator-site-admins/operator-site-admins.module";
import { PkiModule } from "./pki/pki.module";
import { PrismaModule } from "./prisma/prisma.module";
import { RegistrationModule } from "./registration/registration.module";
import { SetupModule } from "./setup/setup.module";
import { SitesModule } from "./sites/sites.module";
import { TestDataModule } from "./test-data/test-data.module";

@Module({
  imports: [
    FixtureIdentifyModule,
    PrismaModule,
    AuthModule,
    AccessModule,
    AuditModule,
    AutomationModule,
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
    FixtureGroupsModule,
    OperatorSiteAdminsModule,
    TestDataModule
  ]
})
export class AppModule {}
