import { BadRequestException } from "@nestjs/common";

export type UserRole = "operator" | "admin" | "viewer";
export type OrganizationType = "service_provider" | "customer";

export function normalizeLoginId(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9._@-]{4,100}$/.test(normalized)) throw new BadRequestException("Invalid login id");
  return normalized;
}

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  organizationType: OrganizationType;
  loginId: string;
  email: string | null;
  name: string;
  role: UserRole;
  status: "active" | "disabled";
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}
