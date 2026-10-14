import { automationCurrentConfigRequestSchema, type AutomationCurrentConfigRequest } from "./automation-contracts.js";

/** Transport declaration only; consumers still verify assignment and live BIO qualification. */
export function supportsBioAutomation(value: AutomationCurrentConfigRequest): boolean {
  const parsed = automationCurrentConfigRequestSchema.safeParse(value);
  return parsed.success && ((parsed.data.schemaVersion === 2 && parsed.data.maxSnapshotVersion === 2)
    || parsed.data.schemaVersion === 3);
}

export function supportsTemporaryBioControl(value: AutomationCurrentConfigRequest): boolean {
  const parsed = automationCurrentConfigRequestSchema.safeParse(value);
  return parsed.success && parsed.data.schemaVersion === 3;
}
