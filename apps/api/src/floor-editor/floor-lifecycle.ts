import { ConflictException } from "@nestjs/common";

export function assertActiveFloorStatus(status: string) {
  if (status !== "active") throw new ConflictException({ code: "floor_archived" });
}
