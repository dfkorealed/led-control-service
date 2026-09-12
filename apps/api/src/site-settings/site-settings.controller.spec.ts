import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { rolesMetadataKey } from "../access/roles.decorator";
import { SiteSettingsController } from "./site-settings.controller";

describe("SiteSettingsController", () => {
  it("keeps operational settings endpoints admin-only", () => {
    expect(Reflect.getMetadata(rolesMetadataKey, SiteSettingsController)).toEqual(["admin"]);
  });

  it("registers the settings reader as GET /settings", () => {
    const handler = SiteSettingsController.prototype.getSettings;

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe("settings");
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
  });

  it("forwards GET settings with the explicit site and authenticated user", async () => {
    const settings = { getSettings: jest.fn().mockResolvedValue({ site: {}, floors: [] }) };
    const controller = new SiteSettingsController(settings as never);
    const user = { id: "admin-1", role: "admin" } as never;

    await expect((controller as any).getSettings("site-1", user)).resolves.toEqual({
      site: {},
      floors: []
    });
    expect(settings.getSettings).toHaveBeenCalledWith(user, "site-1");
  });
});
