-- A deleted requester leaves Command.requestedBy NULL. Keep the existing
-- principal-bound replay domain and add a distinct site-conservative HMAC
-- domain for these legacy rows; no raw client key or actor is reconstructed.
ALTER TABLE "CommandReplayFence"
  DROP CONSTRAINT "CommandReplayFence_domain_check";
ALTER TABLE "CommandReplayFence"
  ADD CONSTRAINT "CommandReplayFence_domain_check"
  CHECK ("domain" IN ('set-replay', 'set-replay-orphan', 'status-check-replay'));
