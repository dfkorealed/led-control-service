import type {
  CreateFixtureGroupInput,
  FixtureGroupMetadata,
  UpdateFixtureGroupInput
} from "@led-control/shared";
import { apiGet, apiPost, apiRequest } from "./client";

export function fixtureGroupQueryKey(siteId: string) {
  return ["fixture-groups", siteId] as const;
}

export function listFixtureGroups(siteId: string, floorId?: string) {
  const query = floorId ? `?floorId=${encodeURIComponent(floorId)}` : "";
  return apiGet<FixtureGroupMetadata[]>(
    `/sites/${encodeURIComponent(siteId)}/fixture-groups${query}`
  );
}

export function createFixtureGroup(siteId: string, input: CreateFixtureGroupInput) {
  return apiPost<FixtureGroupMetadata>(
    `/sites/${encodeURIComponent(siteId)}/fixture-groups`,
    input
  );
}

export function updateFixtureGroup(siteId: string, groupId: string, input: UpdateFixtureGroupInput) {
  return apiRequest<FixtureGroupMetadata>(
    `/sites/${encodeURIComponent(siteId)}/fixture-groups/${encodeURIComponent(groupId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    }
  );
}

export function deleteFixtureGroup(siteId: string, groupId: string) {
  return apiRequest<{
    id: string;
    lifecycleStatus: "retiring";
    meshControlGroup: { status: "retiring"; version: number; error: null };
  }>(
    `/sites/${encodeURIComponent(siteId)}/fixture-groups/${encodeURIComponent(groupId)}`,
    { method: "DELETE" }
  );
}

export function resyncFixtureGroup(siteId: string, groupId: string) {
  return apiPost<FixtureGroupMetadata>(
    `/sites/${encodeURIComponent(siteId)}/fixture-groups/${encodeURIComponent(groupId)}/resync`,
    {}
  );
}
