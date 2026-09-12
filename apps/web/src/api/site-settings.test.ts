import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiGet, apiPatch, apiPost } from "./client";
import {
  archiveFloor,
  createFloor,
  getSiteSettings,
  getFloorFixtureSettings,
  restoreFloor,
  updateFixtureMetadata,
  updateFloor,
  updateSiteSettings
} from "./site-settings";

vi.mock("./client", () => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn()
}));

describe("site settings API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads the selected site's operational settings", async () => {
    vi.mocked(apiGet).mockResolvedValue({ site: {}, floors: [] });

    await getSiteSettings("site / one");

    expect(apiGet).toHaveBeenCalledWith("/sites/site%20%2F%20one/settings");
  });

  it("patches editable site fields", async () => {
    vi.mocked(apiPatch).mockResolvedValue({});
    const input = {
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z",
      name: "새 현장",
      address: "서울",
      timeZone: "Asia/Seoul",
      currency: "KRW",
      tariffKwhRate: 155.5
    };

    await updateSiteSettings("site-1", input);

    expect(apiPatch).toHaveBeenCalledWith("/sites/site-1/settings", input);
  });

  it("creates, updates, archives, and restores a floor through the site-scoped paths", async () => {
    vi.mocked(apiPost).mockResolvedValue({});
    vi.mocked(apiPatch).mockResolvedValue({});

    await createFloor("site-1", { name: "3층", level: 3, displayOrder: 2 });
    await updateFloor("site-1", "floor / 3", {
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z",
      name: "업무층",
      level: 3,
      displayOrder: 4
    });
    await archiveFloor("site-1", "floor / 3", "2026-09-12T00:00:00.000Z");
    await restoreFloor("site-1", "floor / 3", "2026-09-12T00:00:00.000Z");

    expect(apiPost).toHaveBeenNthCalledWith(1, "/sites/site-1/floors", { name: "3층", level: 3, displayOrder: 2 });
    expect(apiPatch).toHaveBeenNthCalledWith(1, "/sites/site-1/floors/floor%20%2F%203", {
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z",
      name: "업무층",
      level: 3,
      displayOrder: 4
    });
    expect(apiPost).toHaveBeenNthCalledWith(2, "/sites/site-1/floors/floor%20%2F%203/archive", {
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z"
    });
    expect(apiPatch).toHaveBeenNthCalledWith(2, "/sites/site-1/floors/floor%20%2F%203", {
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z",
      status: "active"
    });
  });

  it("keeps admin fixture settings pagination at 200 and encodes the cursor", async () => {
    vi.mocked(apiGet).mockResolvedValue({ items: [], nextCursor: null });

    await getFloorFixtureSettings("site-1", "floor-1", "fixture / 200");

    expect(apiGet).toHaveBeenCalledWith(
      "/sites/site-1/floors/floor-1/fixtures/settings?limit=200&cursor=fixture+%2F+200"
    );
  });

  it("loads admin-only fixture identity metadata from the settings endpoint", async () => {
    vi.mocked(apiGet).mockResolvedValue({ items: [], nextCursor: null });

    await getFloorFixtureSettings("site-1", "floor / 1");

    expect(apiGet).toHaveBeenCalledWith("/sites/site-1/floors/floor%20%2F%201/fixtures/settings?limit=200");
  });

  it("patches editable fixture metadata with the expected version", async () => {
    vi.mocked(apiPatch).mockResolvedValue({});
    const input = {
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z",
      name: "주차면 A-01",
      ratedWatt: 42.5
    };

    await updateFixtureMetadata("site-1", "floor-1", "fixture-1", input);

    expect(apiPatch).toHaveBeenCalledWith(
      "/sites/site-1/floors/floor-1/fixtures/fixture-1",
      input
    );
  });
});
