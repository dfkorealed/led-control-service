import { SetMetadata } from "@nestjs/common";
import { UserRole } from "../auth/auth.types";

export const rolesMetadataKey = "roles";
export const rolesErrorCodeMetadataKey = "roles:error-code";

export const Roles = (...roles: UserRole[]) => SetMetadata(rolesMetadataKey, roles);
// Opt-in only: non-site endpoints keep the existing generic role error.
export const RolesErrorCode = (code: string) => SetMetadata(rolesErrorCodeMetadataKey, code);
