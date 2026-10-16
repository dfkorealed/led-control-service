import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { disposablePostgres } from "../../test/support/disposable-postgres";

const path = join(__dirname, "../../prisma/migrations/20261015160000_bio_event_hold_one_second/migration.sql");

describe("BIO one-second hold constraint migration", () => {
  it("admits one-second BIO rows while preserving BlueZ and existing rows", async () => {
    const pg = await disposablePostgres();
    try {
      const database = pg.database();
      pg.sql(database, `CREATE TYPE "VehicleSensorProtocol" AS ENUM ('bio_usb_pulse', 'bluez_stateful');
        CREATE TABLE "VehicleEventRule" (id text PRIMARY KEY, "sensorProtocol" "VehicleSensorProtocol" NOT NULL,
          "holdSeconds" integer NOT NULL DEFAULT 60, brightness integer NOT NULL,
          CONSTRAINT "VehicleEventRule_hold_check" CHECK
          ("holdSeconds" BETWEEN CASE "sensorProtocol" WHEN 'bio_usb_pulse' THEN 10 ELSE 5 END AND 1800));
        INSERT INTO "VehicleEventRule" VALUES ('existing-bio','bio_usb_pulse',10,70),('existing-bluez','bluez_stateful',5,30);`);
      const before = pg.sql(database, 'SELECT row_to_json(r)::text FROM "VehicleEventRule" r ORDER BY id');
      expect(() => pg.sql(database, `INSERT INTO "VehicleEventRule" VALUES ('before','bio_usb_pulse',1,80)`)).toThrow();
      pg.sql(database, existsSync(path) ? readFileSync(path, "utf8") : "");
      expect(pg.sql(database, 'SELECT row_to_json(r)::text FROM "VehicleEventRule" r ORDER BY id')).toBe(before);
      pg.sql(database, `INSERT INTO "VehicleEventRule" VALUES ('new-bio','bio_usb_pulse',1,80)`);
      expect(pg.sql(database, `SELECT "holdSeconds" FROM "VehicleEventRule" WHERE id='new-bio'`)).toBe("1");
      for (const [protocol, hold] of [["bio_usb_pulse", 0], ["bio_usb_pulse", 1801], ["bluez_stateful", 1], ["bluez_stateful", 4]] as const) {
        expect(() => pg.sql(database, `INSERT INTO "VehicleEventRule" VALUES ('invalid','${protocol}',${hold},80)`)).toThrow();
      }
    } finally { pg.stop(); }
  });
});
