import { SetMetadata } from "@nestjs/common";

export const ALLOW_PASSWORD_CHANGE_PENDING = "allowPasswordChangePending";

// Method-only: a controller-wide exception could expose future protected routes.
export const AllowPasswordChangePending = (): MethodDecorator =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_PENDING, true);
