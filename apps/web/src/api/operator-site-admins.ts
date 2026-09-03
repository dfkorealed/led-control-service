import { apiGet, apiPatch, apiPost, apiRequest } from "./client";

export interface SiteAdminSummary {
  siteId: string;
  customerName: string;
  siteName: string;
  installationStatus: "pending" | "installed";
  admin: {
    id: string;
    loginId: string;
    name: string;
    status: "active" | "disabled";
    updatedAt: string;
  } | null;
}

export interface CreateSiteAdminInput {
  customerName: string;
  siteName: string;
  adminName: string;
  loginId: string;
  initialPassword: string;
}

export interface AssignSiteAdminInput {
  adminName: string;
  loginId: string;
  initialPassword: string;
}

export interface UpdateSiteAdminInput {
  adminName: string;
  loginId: string;
}

export const operatorSiteAdminsQueryKey = ["operator", "site-admins"] as const;

export function listSiteAdmins() {
  return apiGet<SiteAdminSummary[]>("/operator/site-admins");
}

export function createSiteAdmin(input: CreateSiteAdminInput) {
  return apiPost<SiteAdminSummary>("/operator/site-admins", input);
}

export function assignSiteAdmin(siteId: string, input: AssignSiteAdminInput) {
  return apiPost<SiteAdminSummary>(`/operator/sites/${encodeURIComponent(siteId)}/admin`, input);
}

export function updateSiteAdmin(userId: string, input: UpdateSiteAdminInput) {
  return apiPatch<SiteAdminSummary["admin"]>(`/operator/site-admins/${encodeURIComponent(userId)}`, input);
}

export function resetSiteAdminPassword(userId: string, newPassword: string) {
  return apiPost<{ ok: true }>(`/operator/site-admins/${encodeURIComponent(userId)}/reset-password`, { newPassword });
}

export function deleteSiteAdmin(userId: string, confirmationSiteName: string) {
  return apiRequest<{ ok: true }>(`/operator/site-admins/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmationSiteName })
  });
}
