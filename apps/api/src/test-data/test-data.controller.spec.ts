import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { RolesGuard } from "../access/roles.guard";
import { rolesMetadataKey } from "../access/roles.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { TestDataController } from "./test-data.controller";
import { TestDataEnabledGuard } from "./test-data-enabled.guard";

describe("TestDataController", () => {
  it("checks the disabled endpoint guard before session and role authentication", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, TestDataController)).toEqual([
      TestDataEnabledGuard,
      SessionAuthGuard,
      RolesGuard
    ]);
    expect(Reflect.getMetadata(rolesMetadataKey, TestDataController)).toEqual(["admin"]);
  });

  it("passes the current user and requested site to the service", async () => {
    const create = jest.fn().mockResolvedValue({ fixtures: { created: 200 } });
    const remove = jest.fn().mockResolvedValue({ fixtures: { deleted: 200 } });
    const controller = new TestDataController({ create, remove } as never);
    const user = { id: "admin-1", role: "admin" } as never;

    await controller.create("site-1", user);
    await controller.remove("site-1", user);

    expect(create).toHaveBeenCalledWith(user, "site-1");
    expect(remove).toHaveBeenCalledWith(user, "site-1");
  });
});
