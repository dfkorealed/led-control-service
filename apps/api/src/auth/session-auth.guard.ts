import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthenticatedRequest } from "./auth.types";

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.readCookie(request.headers.cookie, AuthService.sessionCookieName);
    if (!token) {
      throw new UnauthorizedException("Authentication required");
    }

    const user = await this.authService.getUserBySessionToken(token);
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
