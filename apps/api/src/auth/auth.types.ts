export type UserRole = "operator" | "admin" | "viewer";
export type OrganizationType = "service_provider" | "customer";

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  organizationType: OrganizationType;
  email: string;
  name: string;
  role: UserRole;
  status: "active" | "disabled";
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}
