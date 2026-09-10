import { BadRequestException } from "@nestjs/common";

export type UserRole = "operator" | "admin" | "viewer";
export type OrganizationType = "service_provider" | "customer";

export function normalizeLoginId(value: unknown) {
  if (typeof value !== "string") throw new BadRequestException("Invalid login id");
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9._@-]{4,100}$/.test(normalized)) throw new BadRequestException("Invalid login id");
  return normalized;
}

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  organizationType: OrganizationType;
  loginId: string;
  name: string;
  role: UserRole;
  status: "active" | "disabled";
  mustChangePassword: boolean;
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}
