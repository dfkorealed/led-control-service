import { apiDelete, apiPost } from "./client";

export interface TestDataOperationResult {
  floors: TestDataCounts & { total: number };
  gateways: TestDataCounts;
  fixtures: TestDataCounts;
}

interface TestDataCounts {
  created: number;
  existing: number;
  deleted: number;
}

export function createSiteTestData(siteId: string) {
  return apiPost<TestDataOperationResult>(`/test-data/sites/${encodeURIComponent(siteId)}`, {});
}

export function deleteSiteTestData(siteId: string) {
  return apiDelete<TestDataOperationResult>(`/test-data/sites/${encodeURIComponent(siteId)}`);
}
