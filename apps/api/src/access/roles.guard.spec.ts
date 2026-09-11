import "reflect-metadata";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Roles, RolesErrorCode } from "./roles.decorator";
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
    try { guard.canActivate(context); } catch (error) {
      expect((error as ForbiddenException).getResponse()).toEqual({ statusCode: 403, message: "insufficient role", error: "Forbidden" });
    }
  });

  it("uses opt-in class metadata and gives handler metadata precedence", () => {
    @Roles("admin")
    @RolesErrorCode("CLASS_ROLE_DENIED")
    class TestController {
      list() {}
      @RolesErrorCode("HANDLER_ROLE_DENIED")
      update() {}
    }
    for (const [handler, code] of [["list", "CLASS_ROLE_DENIED"], ["update", "HANDLER_ROLE_DENIED"]] as const) {
      const context = {
        getHandler: () => TestController.prototype[handler], getClass: () => TestController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role: "viewer" } }) })
      } as any;
      const guard = new RolesGuard(new Reflector());
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      try { guard.canActivate(context); } catch (error) {
        expect((error as ForbiddenException).getResponse()).toMatchObject({ code });
      }
    }
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

  it("rejects an unauthenticated request with UnauthorizedException", () => {
    class TestController {
      @Roles("admin")
      manage() {}
    }

    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => TestController.prototype.manage,
      getClass: () => TestController,
      switchToHttp: () => ({ getRequest: () => ({}) })
    } as any;

    expect(() => guard.canActivate(context)).toThrow(new UnauthorizedException("authentication required"));
  });
});
