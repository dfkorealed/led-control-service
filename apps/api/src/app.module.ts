import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { CommandsModule } from "./commands/commands.module";
import { EnergyModule } from "./energy/energy.module";
import { FloorEditorModule } from "./floor-editor/floor-editor.module";
import { FixturesModule } from "./fixtures/fixtures.module";
import { GatewayOnboardingModule } from "./gateway-onboarding/gateway-onboarding.module";
import { PkiModule } from "./pki/pki.module";
import { PrismaModule } from "./prisma/prisma.module";
import { RegistrationModule } from "./registration/registration.module";
import { SetupModule } from "./setup/setup.module";
import { SitesModule } from "./sites/sites.module";

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    SitesModule,
    CommandsModule,
    EnergyModule,
    RegistrationModule,
    SetupModule,
    FloorEditorModule,
    GatewayOnboardingModule,
    PkiModule,
    FixturesModule
  ]
})
export class AppModule {}
