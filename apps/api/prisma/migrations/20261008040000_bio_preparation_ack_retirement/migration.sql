-- A transport retirement must not supersede an otherwise historical checkpoint
-- or pretend that its immutable receipt was published. Existing receipts remain.
ALTER TABLE "BioSensorPreparationOperation" ADD COLUMN "ackRetiredAt" TIMESTAMP(3);
