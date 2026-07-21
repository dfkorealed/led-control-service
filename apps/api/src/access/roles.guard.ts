import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthenticatedRequest, UserRole } from "../auth/auth.types";
import { rolesMetadataKey } from "./roles.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const allowed = this.reflector.getAllAndOverride<UserRole[]>(rolesMetadataKey, [
      context.getHandler(),
      context.getClass()
    ]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!allowed || allowed.includes(request.user!.role)) return true;
    throw new ForbiddenException("insufficient role");
  }
}
