BEGIN;

-- Expand only: retain every stored rule and the legacy BlueZ minimum.
-- ALTER TABLE holds an exclusive lock until the replacement check is installed.
ALTER TABLE "VehicleEventRule"
  DROP CONSTRAINT "VehicleEventRule_hold_check",
  ADD CONSTRAINT "VehicleEventRule_hold_check" CHECK (
    "holdSeconds" BETWEEN CASE "sensorProtocol" WHEN 'bio_usb_pulse' THEN 1 ELSE 5 END AND 1800
  );

COMMIT;
