import { createHash, randomUUID } from "node:crypto";
import type {
  AutomationExecutionKind,
  AutomationExecutionFixtureResultV1
} from "@led-control/shared";
import type {
  AutomationLifecycleEvent,
  AutomationLifecycleHandoff,
  AutomationTerminalHandoff,
  DesiredLightingAction
} from "./schedule-runtime";

export interface AutomationTelemetryRecordInput {
  revision: number;
  ruleId: string | null;
  occurrenceKey: string | null;
  kind: AutomationExecutionKind;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface PersistedAutomationTelemetryHandoff {
  handoffId: string;
  recordsHash: `sha256:${string}`;
  records: AutomationTelemetryRecordInput[];
}

export function createAutomationTelemetryHandoff(
  records: AutomationTelemetryRecordInput[],
  createHandoffId: () => string = randomUUID
): PersistedAutomationTelemetryHandoff | null {
  if (records.length === 0) return null;
  const exactRecords = structuredClone(records);
  return {
    handoffId: createHandoffId(),
    recordsHash: automationTelemetryRecordsHash(exactRecords),
    records: exactRecords
  };
}

export function automationTelemetryRecordsHash(records: AutomationTelemetryRecordInput[]) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(records))).digest("hex")}` as const;
}

export function lifecycleTelemetryRecords(handoff: AutomationLifecycleHandoff) {
  return handoff.events.map((event): AutomationTelemetryRecordInput => ({
    revision: event.revision ?? handoff.revision,
    ruleId: event.ruleId,
    occurrenceKey: event.occurrenceKey,
    kind: event.kind,
    occurredAt: event.occurredAt,
    payload: structuredClone(event.payload)
  }));
}

export function terminalTelemetryRecords(handoff: AutomationTerminalHandoff) {
  const groups = new Map<string, {
    sourceType: "schedule" | "vehicle_event_rule" | "manual_override";
    sourceId: string;
    occurrenceKey: string | null;
    revision: number;
    results: AutomationExecutionFixtureResultV1[];
  }>();
  for (const [index, action] of handoff.actions.entries()) {
    const result = handoff.results[index];
    if (!result || result.fixtureId !== action.fixtureId) {
      throw new Error("automation terminal handoff result order mismatch");
    }
    const source = terminalSource(action, handoff.causes ?? [], handoff.revision);
    if (!source) continue;
    const key = `${source.sourceType}:${source.sourceId}:${source.occurrenceKey ?? ""}`;
    const group = groups.get(key) ?? { ...source, results: [] };
    group.results.push(result);
    groups.set(key, group);
  }

  return [...groups.values()].map((group): AutomationTelemetryRecordInput => ({
    revision: group.revision,
    ruleId: group.sourceType === "manual_override" ? null : group.sourceId,
    occurrenceKey: group.occurrenceKey,
    kind: "action_result",
    occurredAt: group.results.map((result) => result.occurredAt).sort().at(-1)!,
    payload: {
      sourceType: group.sourceType,
      sourceId: group.sourceId,
      results: [...group.results].sort((left, right) => compareStrings(left.fixtureId, right.fixtureId))
    }
  }));
}

function terminalSource(
  action: DesiredLightingAction,
  causes: AutomationLifecycleEvent[],
  defaultRevision: number
) {
  if ((action.sourceType === "schedule" || action.sourceType === "vehicle_event_rule" ||
    action.sourceType === "manual_override") && action.sourceId) {
    return {
      sourceType: action.sourceType,
      sourceId: action.sourceId,
      occurrenceKey: action.occurrenceKey,
      revision: defaultRevision
    };
  }
  const cause = [...causes].reverse().find((candidate) =>
    (candidate.kind === "schedule_ended" || candidate.kind === "event_ended") &&
    payloadTargets(candidate.payload).includes(action.fixtureId)
  );
  if (!cause) return null;
  return {
    sourceType: cause.kind === "schedule_ended" ? "schedule" as const : "vehicle_event_rule" as const,
    sourceId: cause.ruleId,
    occurrenceKey: cause.occurrenceKey,
    revision: cause.revision ?? defaultRevision
  };
}

function payloadTargets(payload: Record<string, unknown>) {
  return Array.isArray(payload.targetFixtureIds)
    ? payload.targetFixtureIds.filter((value): value is string => typeof value === "string")
    : [];
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, child]) => [key, sortJson(child)])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
