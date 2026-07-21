import "reflect-metadata";
import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Roles } from "./roles.decorator";
import { RolesGuard } from "./roles.guard";

describe("RolesGuard", () => {
  it("allows a user whose role is declared on the handler", () => {
    class TestController {
      @Roles("admin")
      manage() {}
    }

    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => TestController.prototype.manage,
      getClass: () => TestController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role: "admin" } }) })
    } as any;

    expect(guard.canActivate(context)).toBe(true);
  });

  it("rejects a user whose role is not declared on the handler", () => {
    class TestController {
      @Roles("admin")
      manage() {}
    }

    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => TestController.prototype.manage,
      getClass: () => TestController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role: "viewer" } }) })
    } as any;

    expect(() => guard.canActivate(context)).toThrow(new ForbiddenException("insufficient role"));
  });

  it("allows authenticated users when no role metadata is declared", () => {
    class TestController {
      manage() {}
    }

    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => TestController.prototype.manage,
      getClass: () => TestController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role: "viewer" } }) })
    } as any;

    expect(guard.canActivate(context)).toBe(true);
  });
});
