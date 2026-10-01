-- Server-only attribution metadata. Historical rows deliberately stay NULL:
-- current Fixture membership cannot recover a snapshot's original source.
ALTER TABLE "MqttOutbox" ADD COLUMN "automationSourceBindings" JSONB;
ALTER TABLE "MqttOutbox" ADD CONSTRAINT "MqttOutbox_automation_source_bindings_object"
  CHECK ("automationSourceBindings" IS NULL OR jsonb_typeof("automationSourceBindings") = 'object');
