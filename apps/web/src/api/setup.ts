import { apiPost } from "./client";
import type { Dashboard } from "./queries";

export interface InitialFloorInput {
  name: string;
  level: number;
  floorPlan?: {
    imageUrl: string;
    width: number;
    height: number;
  };
}

export interface InitialSiteSetupRequest {
  customerOrganizationName: string;
  siteName: string;
  address: string;
  tariffKwhRate: number;
  timeZone?: string;
  floors: InitialFloorInput[];
}

export interface ClaimGatewayRequest {
  siteId: string;
  name: string;
  serialNumber: string;
  claimCode: string;
}

export function claimGateway(payload: ClaimGatewayRequest) {
  return apiPost<{ status: "claimed"; gatewayId: string; siteId: string; serialNumber: string }>(
    "/gateways/claim",
    payload
  );
}

export function createInitialSiteSetup(payload: InitialSiteSetupRequest) {
  return apiPost<Dashboard>("/setup/initial-site", payload);
}
