BEGIN;

UPDATE "MqttOutbox" AS outbox
SET
  "payload" = outbox."payload" - 'requestedBy',
  "updatedAt" = CURRENT_TIMESTAMP
FROM "CommandDispatch" AS dispatch
WHERE outbox."dispatchId" = dispatch."id"
  AND jsonb_typeof(outbox."payload") = 'object'
  AND outbox."payload" ? 'requestedBy';

COMMIT;
