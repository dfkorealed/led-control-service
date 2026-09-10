BEGIN;

UPDATE "MqttOutbox" AS outbox
SET
  "payload" = outbox."payload" - 'requestedBy',
  "updatedAt" = CURRENT_TIMESTAMP
FROM "CommandDispatch" AS dispatch
WHERE outbox."dispatchId" = dispatch."id"
  AND jsonb_typeof(outbox."payload") = 'object'
  AND outbox."payload" ? 'requestedBy';

ALTER TABLE "MqttOutbox"
ADD CONSTRAINT "MqttOutbox_command_payload_no_requested_by_check" CHECK (
  "dispatchId" IS NULL
  OR jsonb_typeof("payload") <> 'object'
  OR NOT ("payload" ? 'requestedBy')
);

COMMIT;
