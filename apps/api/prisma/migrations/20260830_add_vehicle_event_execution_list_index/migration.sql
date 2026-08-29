DROP INDEX "AutomationExecution_vehicleEventRuleId_idx";

CREATE INDEX "AutomationExecution_vehicleEventRuleId_occurredAt_sequence_idx"
ON "AutomationExecution"("vehicleEventRuleId", "occurredAt" DESC, "sequence" DESC);
