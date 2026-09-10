import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthService } from "./auth.service";
import { AuthenticatedRequest } from "./auth.types";
import { ALLOW_PASSWORD_CHANGE_PENDING } from "./allow-password-change-pending.decorator";

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.readCookie(request.headers.cookie, AuthService.sessionCookieName);
    if (!token) {
      throw new UnauthorizedException("Authentication required");
    }

    const user = await this.authService.getUserBySessionToken(token);
    if (user.mustChangePassword && this.reflector.get<boolean>(ALLOW_PASSWORD_CHANGE_PENDING, context.getHandler()) !== true) {
      throw new ForbiddenException({ code: "PASSWORD_CHANGE_REQUIRED", message: "Password change required" });
    }
    request.user = user;
    return true;
  }

  private readCookie(cookieHeader: string | string[] | undefined, name: string) {
    const header = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader;
    if (!header) return null;

    const cookies = header.split(";").map((part) => part.trim());
    const cookie = cookies.find((part) => part.startsWith(`${name}=`));
    if (!cookie) return null;
    return decodeURIComponent(cookie.slice(name.length + 1));
  }
}
