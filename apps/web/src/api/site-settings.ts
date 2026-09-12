import { apiGet, apiPatch, apiPost } from "./client";
import type { FixtureSnapshot } from "./queries";

export type FloorStatus = "active" | "archived";

export interface SiteSettings {
  id: string;
  name: string;
  address: string | null;
  timeZone: string;
  currency: string;
  tariffKwhRate: number | null;
  updatedAt: string;
}

export interface SiteSettingsFloor {
  id: string;
  name: string;
  level: number;
  status: FloorStatus;
  displayOrder: number;
  fixtureCount: number;
  activeGroupCount: number;
  updatedAt: string;
}

export interface SiteSettingsResponse {
  site: SiteSettings;
  floors: SiteSettingsFloor[];
}

export type SiteFloorMutationResult = Omit<SiteSettingsFloor, "fixtureCount" | "activeGroupCount">;

export interface UpdateSiteSettingsInput {
  expectedUpdatedAt: string;
  name: string;
  address: string | null;
  timeZone: string;
  currency: string;
  tariffKwhRate: number | null;
}

export interface CreateFloorInput {
  name: string;
  level: number;
  displayOrder: number;
}

export type UpdateFloorInput = Partial<CreateFloorInput> & {
  expectedUpdatedAt: string;
};

export interface SiteFixture extends FixtureSnapshot {
  serialNumber?: string | null;
  deviceUuid?: string | null;
  meshAddress?: string | null;
  firmwareVersion?: string | null;
}

export interface FixtureSettingsItem {
  id: string;
  name: string;
  ratedWatt: number;
  serialNumber: string | null;
  deviceUuid: string | null;
  meshAddress: string | null;
  firmwareVersion: string | null;
}

export interface FloorFixtureSettingsResponse {
  items: FixtureSettingsItem[];
}

export interface FloorFixturesPage {
  items: SiteFixture[];
  nextCursor: string | null;
}

export interface UpdateFixtureMetadataInput {
  name: string;
  ratedWatt: number;
}

export function siteSettingsQueryKey(siteId: string) {
  return ["site-settings", siteId] as const;
}

export function floorFixturesQueryKey(siteId: string, floorId?: string) {
  return floorId
    ? ["floor-fixtures", siteId, floorId] as const
    : ["floor-fixtures", siteId] as const;
}

export function floorFixtureSettingsQueryKey(siteId: string, floorId?: string) {
  return floorId
    ? ["floor-fixture-settings", siteId, floorId] as const
    : ["floor-fixture-settings", siteId] as const;
}

export function getSiteSettings(siteId: string) {
  return apiGet<SiteSettingsResponse>(`/sites/${encodeURIComponent(siteId)}/settings`);
}

export function updateSiteSettings(siteId: string, input: UpdateSiteSettingsInput) {
  return apiPatch<SiteSettings>(`/sites/${encodeURIComponent(siteId)}/settings`, input);
}

export function createFloor(siteId: string, input: CreateFloorInput) {
  return apiPost<SiteFloorMutationResult>(`/sites/${encodeURIComponent(siteId)}/floors`, input);
}

export function updateFloor(siteId: string, floorId: string, input: UpdateFloorInput) {
  return apiPatch<SiteFloorMutationResult>(
    `/sites/${encodeURIComponent(siteId)}/floors/${encodeURIComponent(floorId)}`,
    input
  );
}

export function archiveFloor(siteId: string, floorId: string, expectedUpdatedAt: string) {
  return apiPost<SiteFloorMutationResult>(
    `/sites/${encodeURIComponent(siteId)}/floors/${encodeURIComponent(floorId)}/archive`,
    { expectedUpdatedAt }
  );
}

export function restoreFloor(siteId: string, floorId: string, expectedUpdatedAt: string) {
  return apiPatch<SiteFloorMutationResult>(
    `/sites/${encodeURIComponent(siteId)}/floors/${encodeURIComponent(floorId)}`,
    { status: "active", expectedUpdatedAt }
  );
}

export function listFloorFixtures(siteId: string, floorId: string, cursor?: string) {
  const search = new URLSearchParams({ limit: "200" });
  if (cursor) search.set("cursor", cursor);
  return apiGet<FloorFixturesPage>(
    `/sites/${encodeURIComponent(siteId)}/floors/${encodeURIComponent(floorId)}/fixtures?${search.toString()}`
  );
}

export function getFloorFixtureSettings(siteId: string, floorId: string) {
  return apiGet<FloorFixtureSettingsResponse>(
    `/sites/${encodeURIComponent(siteId)}/floors/${encodeURIComponent(floorId)}/fixtures/settings`
  );
}

export function updateFixtureMetadata(
  siteId: string,
  floorId: string,
  fixtureId: string,
  input: UpdateFixtureMetadataInput
) {
  return apiPatch<Pick<SiteFixture, "id" | "name" | "ratedWatt"> & { floorId: string }>(
    `/sites/${encodeURIComponent(siteId)}/floors/${encodeURIComponent(floorId)}/fixtures/${encodeURIComponent(fixtureId)}`,
    input
  );
}
