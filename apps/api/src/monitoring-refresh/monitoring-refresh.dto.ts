import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const monitoringRefreshInputSchema = z.object({
  clientRequestId: z.string().uuid()
}).strict();

export type MonitoringRefreshInput = z.infer<typeof monitoringRefreshInputSchema>;

export function parseMonitoringRefreshInput(input: unknown): MonitoringRefreshInput {
  const parsed = monitoringRefreshInputSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException("invalid monitoring refresh request");
  return parsed.data;
}
