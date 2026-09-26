-- Additive only. The existing immutable receipt trigger still rejects every
-- UPDATE, including setting this marker. A separate guarded cutover must
-- verify old Command attribution, exact application ACK and keyed receipt in
-- one fenced deletion transaction before it installs a narrow setter.
ALTER TABLE "ManualExecutionReplayReceipt"
  ADD COLUMN "sourceRetiredAt" TIMESTAMP(3);
