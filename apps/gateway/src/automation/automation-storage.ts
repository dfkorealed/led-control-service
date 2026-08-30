import type { AutomationScope } from "./automation-config-store";
import { FileAutomationStateStore } from "./automation-state-store";
import { AutomationTelemetryGapJournal } from "./automation-telemetry-gap-journal";
import {
  AUTOMATION_TELEMETRY_MAX_BYTES,
  AutomationTelemetryOutbox
} from "./automation-telemetry-outbox";
import { StorageHeadroomManager } from "../storage/storage-headroom-manager";

interface CreateAutomationStorageOptions {
  statePath: string;
  telemetryOutboxPath: string;
  scope: AutomationScope;
  telemetryMaxBytes?: number;
  headroomBytes?: number;
  onStateDurabilityChange?: (mode: "ready" | "degraded", reason: string | null) => void;
  onStorageError?: (error: unknown) => void;
}

export function createAutomationStorage(options: CreateAutomationStorageOptions) {
  const maxBytes = options.telemetryMaxBytes ?? AUTOMATION_TELEMETRY_MAX_BYTES;
  const gapJournal = new AutomationTelemetryGapJournal(`${options.telemetryOutboxPath}.gap`);
  const headroom = new StorageHeadroomManager(
    `${options.telemetryOutboxPath}.reserve`,
    options.headroomBytes ?? AUTOMATION_TELEMETRY_MAX_BYTES,
    { onBackgroundError: (error) => options.onStorageError?.(error) }
  );
  const stateStore = new FileAutomationStateStore(
    options.statePath,
    undefined,
    undefined,
    {
      headroom,
      gapJournal,
      ...(options.onStateDurabilityChange ? { onDurabilityChange: options.onStateDurabilityChange } : {}),
      ...(options.onStorageError ? { onGapJournalError: options.onStorageError } : {})
    }
  );
  const telemetryOutbox = new AutomationTelemetryOutbox(
    options.telemetryOutboxPath,
    options.scope,
    { maxBytes, headroom, gapJournal }
  );

  return {
    gapJournal,
    headroom,
    stateStore,
    telemetryOutbox,
    async initialize() {
      try {
        await gapJournal.initialize();
      } catch (error) {
        options.onStorageError?.(error);
      }
      const headroomInitialization = await headroom.initialize();
      const state = await stateStore.initialize();
      const telemetryInitialization = await telemetryOutbox.initialize();
      return {
        headroom: headroomInitialization,
        state,
        telemetry: telemetryInitialization
      };
    }
  };
}
