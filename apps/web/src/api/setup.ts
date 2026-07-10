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
  siteName: string;
  address: string;
  tariffKwhRate: number;
  floors: InitialFloorInput[];
  gateway: {
    name: string;
    serialNumber: string;
  };
}

export function createInitialSiteSetup(payload: InitialSiteSetupRequest) {
  return apiPost<Dashboard>("/setup/initial-site", payload);
}
