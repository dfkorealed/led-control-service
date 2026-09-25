import { Inject, Injectable } from "@nestjs/common";

export interface LandingMailConnection {
  getConnectionStatus(): Promise<{ connected: boolean }>;
}

export const LANDING_MAIL_CONNECTION = Symbol("LANDING_MAIL_CONNECTION");
export const InjectLandingMailConnection = () => Inject(LANDING_MAIL_CONNECTION);

@Injectable()
export class UnconfiguredLandingMailConnection implements LandingMailConnection {
  async getConnectionStatus() { return { connected: false }; }
}
