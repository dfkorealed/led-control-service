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
import { MonitoringIncidentsModule } from "./monitoring-incidents/monitoring-incidents.module";
import { OperatorSiteAdminsModule } from "./operator-site-admins/operator-site-admins.module";
import { PkiModule } from "./pki/pki.module";
import { PrismaModule } from "./prisma/prisma.module";
import { RegistrationModule } from "./registration/registration.module";
import { RetentionModule } from "./retention/retention.module";
import { SetupModule } from "./setup/setup.module";
import { SitesModule } from "./sites/sites.module";
import { SiteUsersModule } from "./site-users/site-users.module";
import { SiteSettingsModule } from "./site-settings/site-settings.module";
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
    MonitoringIncidentsModule,
    SiteSettingsModule,
    SiteUsersModule,
    CommandsModule,
    EnergyModule,
    RegistrationModule,
    RetentionModule,
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
