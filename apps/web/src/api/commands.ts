import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./client";

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

const terminalStages = new Set<CommandStage>(["completed", "partial_failed", "failed", "timed_out"]);

export function useCommandStatus(commandId: string | null) {
  return useQuery({
    queryKey: ["command-status", commandId],
    queryFn: () => apiGet<CommandStatusResponse>(`/commands/${commandId}`),
    enabled: Boolean(commandId),
    refetchInterval: (query) => {
      const stage = query.state.data?.stage;
      return stage && terminalStages.has(stage) ? false : 1000;
    }
  });
}
