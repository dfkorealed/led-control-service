import { useQuery } from "@tanstack/react-query";
import type { CreateDimmingCommandInput } from "@led-control/shared";
import { apiGet, apiPost } from "./client";

export type CommandDeliveryMode = "unicast" | "parallel_unicast" | "mesh_group";

export interface CreateDimmingCommandResponse {
  id: string;
  dispatchCount: number;
  selectedTargetCount: number;
  transmissionCount: number;
  deliveryMode: CommandDeliveryMode;
  terminalStatusUrl: string;
}

export type CommandStage = "queued" | "published" | "accepted" | "completed" | "partial_failed" | "failed" | "timed_out";

export interface CommandStatusResponse {
  id: string;
  stage: CommandStage;
  dispatchCount: number;
  completedFixtureCount: number;
  totalFixtureCount: number;
  errorMessage: string | null;
  dispatches: Array<{
    id: string;
    status: string;
    gateway: { id: string; name: string };
    errorMessage: string | null;
    results: Array<{
      fixtureId: string;
      fixtureName: string;
      status: "pending" | "succeeded" | "failed" | "timed_out";
      errorMessage: string | null;
    }>;
  }>;
}

export const TERMINAL_COMMAND_STAGES: ReadonlySet<CommandStage> = new Set([
  "completed",
  "partial_failed",
  "failed",
  "timed_out"
]);

export function isTerminalCommandStage(stage: CommandStage | null | undefined): boolean {
  return Boolean(stage && TERMINAL_COMMAND_STAGES.has(stage));
}

export function createDimmingCommand(input: CreateDimmingCommandInput) {
  return apiPost<CreateDimmingCommandResponse>("/commands/dimming", input);
}

export function useCommandStatus(commandId: string | null) {
  return useQuery({
    queryKey: ["command-status", commandId],
    queryFn: () => apiGet<CommandStatusResponse>(`/commands/${commandId}`),
    enabled: Boolean(commandId),
    refetchInterval: (query) => {
      const stage = query.state.data?.stage;
      return isTerminalCommandStage(stage) ? false : 1000;
    }
  });
}
