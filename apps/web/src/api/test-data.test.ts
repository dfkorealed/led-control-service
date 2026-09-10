import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSiteTestData, deleteSiteTestData } from "./test-data";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiDelete: vi.fn()
}));

vi.mock("./client", () => mocks);

describe("test data API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiPost.mockResolvedValue(testDataResult({ created: 12 }));
    mocks.apiDelete.mockResolvedValue(testDataResult({ deleted: 12 }));
  });

  it("uses the approved create and delete site test-data contracts", async () => {
    await expect(createSiteTestData("site / 1")).resolves.toEqual(testDataResult({ created: 12 }));
    await expect(deleteSiteTestData("site / 1")).resolves.toEqual(testDataResult({ deleted: 12 }));

    expect(mocks.apiPost).toHaveBeenCalledWith("/test-data/sites/site%20%2F%201", {});
    expect(mocks.apiDelete).toHaveBeenCalledWith("/test-data/sites/site%20%2F%201");
  });
});

function testDataResult({ created = 0, deleted = 0 }: { created?: number; deleted?: number }) {
  return {
    floors: { total: 2, created: 0, existing: 2, deleted: 0 },
    gateways: { created: 0, existing: 0, deleted: 0 },
    fixtures: { created, existing: 0, deleted }
  };
}
