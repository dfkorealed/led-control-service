import { describe, expect, it } from "vitest";
import { emptyAutomationState } from "../automation/automation-state-store";
import { automationSnapshot } from "../automation/automation-test-fixtures";
import { automationRegistrationRemovalBlocker, referencesRegistration, resultIsUncertain } from "./registration-removal-safety";
import { mappingInput } from "../../test/registration-removal-fixtures";

const id = mappingInput.fixtureId;
describe("registration removal runtime safety", () => {
  it("allows a quiescent fixture independently of online status", () => {
    expect(automationRegistrationRemovalBlocker(id, automationSnapshot(1), emptyAutomationState())).toBeNull();
  });
  it("blocks disabled saved schedule references", () => {
    const snapshot = automationSnapshot(1, { schedules: [{ id: "schedule", status: "disabled", fixtureIds: [id] } as never] });
    expect(automationRegistrationRemovalBlocker(id, snapshot, emptyAutomationState())).toBe("SCHEDULE_REFERENCED");
  });
  it.each(["sourceFixtureIds", "targetFixtureIds"] as const)("blocks disabled event %s references", key => {
    const snapshot = automationSnapshot(1, { vehicleEventRules: [{ status: "disabled", sourceFixtureIds: [], targetFixtureIds: [], [key]: [id] } as never] });
    expect(automationRegistrationRemovalBlocker(id, snapshot, emptyAutomationState())).toBe("EVENT_REFERENCED");
  });
  it("does not discard a temporary restoration obligation after its deadline", () => {
    const state = emptyAutomationState(); state.fixtureLeases[id] = { sessionId: "session" } as never;
    expect(automationRegistrationRemovalBlocker(id, null, state)).toBe("RESTORATION_REQUIRED");
  });
  it("preserves an uncertain manual transition", () => {
    const state = emptyAutomationState(); state.transitionsByFixture[id] = { phase: "terminal", status: "timed_out" } as never;
    expect(automationRegistrationRemovalBlocker(id, null, state)).toBe("CONTROL_UNCERTAIN");
  });
  it("preserves an unfinished BIO restore", () => {
    const state = emptyAutomationState(); state.bioTargetsByFixture[id] = { restoreResult: { status: "failed" } } as never;
    expect(automationRegistrationRemovalBlocker(id, null, state)).toBe("RESTORATION_REQUIRED");
  });
  it("matches external provisioning node IDs without confusing them with canonical Cloud node IDs", () => {
    expect(referencesRegistration({ command: { nodeId: mappingInput.nodeId } }, id, mappingInput.nodeId)).toBe(true);
    expect(referencesRegistration({ command: { nodeId: "cloud-node", note: id } }, id, mappingInput.nodeId)).toBe(false);
  });
  it.each(["timed_out", "unknown", "outcome_unknown", "unverified"])("recognizes retained %s uncertainty", status => {
    expect(resultIsUncertain({ results: [{ status }] })).toBe(true);
  });
});
