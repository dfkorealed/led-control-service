DROP INDEX "AutomationExecution_lightingScheduleId_idx";

CREATE INDEX "AutomationExecution_lightingScheduleId_occurredAt_sequence_idx"
ON "AutomationExecution"("lightingScheduleId", "occurredAt" DESC, "sequence" DESC);
