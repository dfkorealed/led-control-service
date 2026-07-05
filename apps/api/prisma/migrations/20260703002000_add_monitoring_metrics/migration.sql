-- AlterTable
ALTER TABLE "Fixture" ADD COLUMN "rssi" INTEGER,
ADD COLUMN "hopCount" INTEGER,
ADD COLUMN "commandSuccessRate" DOUBLE PRECISION;
