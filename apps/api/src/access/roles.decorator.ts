import { SetMetadata } from "@nestjs/common";
import { UserRole } from "../auth/auth.types";

export const rolesMetadataKey = "roles";

export const Roles = (...roles: UserRole[]) => SetMetadata(rolesMetadataKey, roles);
