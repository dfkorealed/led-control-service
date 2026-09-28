import { Module } from "@nestjs/common";
import { FixtureIdentifyModule } from "./fixture-identify/fixture-identify.module";
import { AccessModule } from "./access/access.module";
import { AuditModule } from "./audit/audit.module";
import { AutomationModule } from "./automation/automation.module";
import { AuthModule } from "./auth/auth.module";
import { CommandsModule } from "./commands/commands.module";
import { EnergyModule } from "./energy/energy.module";
import { FloorEditorModule } from "./floor-editor/floor-editor.module";
import { MapDocumentQueryModule } from "./floor-editor/map-document-query.module";
import { FloorMapModule } from "./floor-map/floor-map.module";
import { FloorImportModule } from "./floor-import/floor-import.module";
import { FixturesModule } from "./fixtures/fixtures.module";
import { FixtureGroupsModule } from "./fixture-groups/fixture-groups.module";
import { GatewayOnboardingModule } from "./gateway-onboarding/gateway-onboarding.module";
import { MeshControlGroupModule } from "./mesh-control-groups/mesh-control-group.module";
import { MonitoringIncidentsModule } from "./monitoring-incidents/monitoring-incidents.module";
import { MonitoringActivityModule } from "./monitoring-activity/monitoring-activity.module";
import { MonitoringRefreshModule } from "./monitoring-refresh/monitoring-refresh.module";
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
import { ObservabilityModule } from "./observability/observability.module";
import { LandingInquiriesModule } from "./landing-inquiries/landing-inquiries.module";

@Module({
  imports: [
    ObservabilityModule,
    FixtureIdentifyModule,
    PrismaModule,
    AuthModule,
    AccessModule,
    AuditModule,
    AutomationModule,
    SitesModule,
    MonitoringIncidentsModule,
    MonitoringActivityModule,
    MonitoringRefreshModule,
    SiteSettingsModule,
    SiteUsersModule,
    CommandsModule,
    EnergyModule,
    RegistrationModule,
    RetentionModule,
    MeshControlGroupModule,
    SetupModule,
    FloorEditorModule,
    MapDocumentQueryModule,
    FloorImportModule,
    FloorMapModule,
    GatewayOnboardingModule,
    PkiModule,
    FixturesModule,
    FixtureGroupsModule,
    OperatorSiteAdminsModule,
    LandingInquiriesModule,
    TestDataModule
  ]
})
export class AppModule {}
