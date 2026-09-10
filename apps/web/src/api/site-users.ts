import { useQuery } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPatch, apiPost } from "./client";

export type SiteUserAccessLevel = "read" | "control";
export type SiteUserStatus = "active" | "disabled";

export interface SiteUserSummary {
  id: string;
  name: string;
  loginId: string;
  accessLevel: SiteUserAccessLevel;
  status: SiteUserStatus;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SiteUsersResponse {
  users: SiteUserSummary[];
  count: number;
  limit: number;
}

export interface CreateSiteUserInput {
  name: string;
  loginId: string;
  temporaryPassword: string;
  accessLevel: SiteUserAccessLevel;
  status: SiteUserStatus;
}

export interface UpdateSiteUserInput {
  name: string;
  loginId: string;
  accessLevel: SiteUserAccessLevel;
  status: SiteUserStatus;
  expectedUpdatedAt: string;
}

export function siteUsersQueryKey(siteId: string) {
  return ["site-users", siteId] as const;
}

export function listSiteUsers(siteId: string) {
  return apiGet<SiteUsersResponse>(siteUsersPath(siteId));
}

export function useSiteUsers(siteId?: string) {
  return useQuery({
    queryKey: siteUsersQueryKey(siteId ?? "unselected"),
    queryFn: () => listSiteUsers(siteId!),
    enabled: Boolean(siteId)
  });
}

// Password-bearing operations deliberately stay outside useMutation so
// React Query's mutation cache never retains plaintext credentials.
export function createSiteUser(siteId: string, input: CreateSiteUserInput) {
  return apiPost<SiteUserSummary>(siteUsersPath(siteId), input);
}

export function updateSiteUser(siteId: string, userId: string, input: UpdateSiteUserInput) {
  return apiPatch<SiteUserSummary>(siteUserPath(siteId, userId), input);
}

export function resetSiteUserPassword(siteId: string, userId: string, temporaryPassword: string) {
  return apiPost<{ ok: true }>(`${siteUserPath(siteId, userId)}/reset-password`, { temporaryPassword });
}

export function deleteSiteUser(siteId: string, userId: string, confirmationLoginId: string) {
  return apiDelete<{ ok: true }>(siteUserPath(siteId, userId), { confirmationLoginId });
}

function siteUsersPath(siteId: string) {
  return `/sites/${encodeURIComponent(siteId)}/users`;
}

function siteUserPath(siteId: string, userId: string) {
  return `${siteUsersPath(siteId)}/${encodeURIComponent(userId)}`;
}
