ALTER TABLE "FloorMapStage"
  ADD COLUMN "preparedGenerationId" TEXT,
  ADD COLUMN "commitRequested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FloorMapStage" ADD CONSTRAINT "FloorMapStage_preparedGenerationId_floorId_fkey"
  FOREIGN KEY ("preparedGenerationId", "floorId") REFERENCES "FloorMapGeneration"("id", "floorId")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "FloorMapStage_preparedGenerationId_idx" ON "FloorMapStage"("preparedGenerationId");
