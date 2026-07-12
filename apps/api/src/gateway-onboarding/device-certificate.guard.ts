import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";

export interface DeviceCertificateRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: {
    authorized?: boolean;
    getPeerCertificate?: () => { fingerprint256?: string };
  };
  deviceCertificateFingerprint?: string;
}

@Injectable()
export class DeviceCertificateGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<DeviceCertificateRequest>();
    const peer = request.socket?.getPeerCertificate?.();
    const fingerprint = request.socket?.authorized ? peer?.fingerprint256 : undefined;

    if (!fingerprint) throw new UnauthorizedException("mTLS device certificate required");
    request.deviceCertificateFingerprint = this.normalizeFingerprint(fingerprint);
    return true;
  }

  private normalizeFingerprint(value: string) {
    return value.replace(/:/g, "").trim().toUpperCase();
  }
}
