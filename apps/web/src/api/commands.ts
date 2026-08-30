import { useQuery } from "@tanstack/react-query";
import type { CreateDimmingCommandInput } from "@led-control/shared";
import { apiGet, apiPost } from "./client";

export type CommandDeliveryMode = "unicast" | "parallel_unicast" | "mesh_group";

export interface CreateDimmingCommandResponse {
  id: string;
  overrideUntil?: string;
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

export function getCommandStatusRefetchInterval(
  requestedCommandId: string | null,
  status: CommandStatusResponse | null | undefined
): 1000 | false {
  return status?.id === requestedCommandId && isTerminalCommandStage(status.stage) ? false : 1000;
}

export function createDimmingCommand(input: CreateDimmingCommandInput, signal?: AbortSignal) {
  return apiPost<CreateDimmingCommandResponse>(
    "/commands/dimming",
    canonicalizeDimmingCommandInput(input),
    { signal }
  );
}

export function canonicalizeDimmingCommandInput(
  input: CreateDimmingCommandInput
): CreateDimmingCommandInput {
  if (input.target.type !== "fixtures") return input;
  return {
    ...input,
    target: {
      ...input.target,
      fixtureIds: [...input.target.fixtureIds].sort()
    }
  };
}

export function useCommandStatus(commandId: string | null) {
  return useQuery({
    queryKey: ["command-status", commandId],
    queryFn: () => apiGet<CommandStatusResponse>(`/commands/${commandId}`),
    enabled: Boolean(commandId),
    refetchInterval: (query) => getCommandStatusRefetchInterval(commandId, query.state.data)
  });
}
