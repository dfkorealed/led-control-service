import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthenticatedRequest, UserRole } from "../auth/auth.types";
import { rolesErrorCodeMetadataKey, rolesMetadataKey } from "./roles.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const allowed = this.reflector.getAllAndOverride<UserRole[]>(rolesMetadataKey, [
      context.getHandler(),
      context.getClass()
    ]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user) throw new UnauthorizedException("authentication required");
    if (!allowed || allowed.includes(request.user.role)) return true;
    const code = this.reflector.getAllAndOverride<string>(rolesErrorCodeMetadataKey, [context.getHandler(), context.getClass()]);
    if (code) throw new ForbiddenException({ code, message: "insufficient role" });
    throw new ForbiddenException("insufficient role");
  }
}
