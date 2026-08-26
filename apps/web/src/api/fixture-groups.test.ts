import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateFixtureGroupInput, FixtureGroupMetadata } from "@led-control/shared";
import {
  createFixtureGroup,
  deleteFixtureGroup,
  listFixtureGroups,
  resyncFixtureGroup,
  updateFixtureGroup
} from "./fixture-groups";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiRequest: vi.fn()
}));

vi.mock("./client", () => mocks);

const siteId = "00000000-0000-4000-8000-000000000001";
const floorId = "00000000-0000-4000-8000-000000000002";
const groupId = "00000000-0000-4000-8000-000000000003";
const input: CreateFixtureGroupInput = {
  name: "B2 입구",
  floorId,
  gatewayId: "00000000-0000-4000-8000-000000000004",
  fixtureIds: ["00000000-0000-4000-8000-000000000005"]
};
const metadata: FixtureGroupMetadata = {
  id: groupId,
  name: input.name,
  floorId,
  gatewayId: input.gatewayId,
  lifecycleStatus: "active",
  fixtureCount: 1,
  meshControlGroup: { status: "configuring", version: 1, error: null }
};

describe("fixture group API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiGet.mockResolvedValue([metadata]);
    mocks.apiPost.mockResolvedValue(metadata);
    mocks.apiRequest.mockResolvedValue(metadata);
  });

  it("lists all groups or a floor-scoped group list", async () => {
    await expect(listFixtureGroups(siteId)).resolves.toEqual([metadata]);
    await expect(listFixtureGroups(siteId, floorId)).resolves.toEqual([metadata]);

    expect(mocks.apiGet).toHaveBeenNthCalledWith(1, `/sites/${siteId}/fixture-groups`);
    expect(mocks.apiGet).toHaveBeenNthCalledWith(2, `/sites/${siteId}/fixture-groups?floorId=${floorId}`);
  });

  it("uses the production create, update, delete, and resync contracts", async () => {
    await createFixtureGroup(siteId, input);
    await updateFixtureGroup(siteId, groupId, input);
    await deleteFixtureGroup(siteId, groupId);
    await resyncFixtureGroup(siteId, groupId);

    expect(mocks.apiPost).toHaveBeenNthCalledWith(1, `/sites/${siteId}/fixture-groups`, input);
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(1, `/sites/${siteId}/fixture-groups/${groupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(2, `/sites/${siteId}/fixture-groups/${groupId}`, {
      method: "DELETE"
    });
    expect(mocks.apiPost).toHaveBeenNthCalledWith(2, `/sites/${siteId}/fixture-groups/${groupId}/resync`, {});
  });
});
