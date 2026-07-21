import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { RolesGuard } from "../access/roles.guard";
import { rolesMetadataKey } from "../access/roles.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { RegistrationController } from "./registration.controller";

describe("RegistrationController", () => {
  it("requires the operator role for every registration route", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, RegistrationController)).toEqual(
      expect.arrayContaining([SessionAuthGuard, RolesGuard])
    );
    expect(Reflect.getMetadata(rolesMetadataKey, RegistrationController)).toEqual(["operator"]);
  });
});
