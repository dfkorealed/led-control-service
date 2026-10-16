import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { disposablePostgres } from '../../test/support/disposable-postgres';
const migration = join(__dirname, '../../prisma/migrations/20261016100000_bio_native_self_control/migration.sql');
describe('BIO self-only cardinality migration', () => {
    it('preserves old rules and admits only one BIO source with an explicit native output', async () => {
        const pg = await disposablePostgres();
        try {
            const db = pg.database();
            pg.sql(db, `CREATE TABLE "GatewayAutomationProtocolSupport" (id text PRIMARY KEY);
    CREATE FUNCTION "lock_automation_membership_mutation"() RETURNS void LANGUAGE sql AS 'SELECT pg_advisory_xact_lock(1279607873,1296387394)';
    CREATE TABLE "VehicleEventRule" (id text PRIMARY KEY,"sensorProtocol" text NOT NULL,status text NOT NULL,"sourceCount" integer NOT NULL,"targetCount" integer NOT NULL,
      "holdSeconds" integer NOT NULL DEFAULT 60,"dimmingEnabled" boolean NOT NULL DEFAULT true,"brightnessPercent" integer NOT NULL DEFAULT 70);
    CREATE TABLE "VehicleEventSource" ("ruleId" text NOT NULL,"fixtureId" text NOT NULL);
    CREATE TABLE "VehicleEventTarget" ("ruleId" text NOT NULL,"fixtureId" text NOT NULL);
    INSERT INTO "VehicleEventRule" (id,"sensorProtocol",status,"sourceCount","targetCount") VALUES ('old','bio_usb_pulse','disabled',1,1);
    INSERT INTO "VehicleEventSource" VALUES ('old','source');INSERT INTO "VehicleEventTarget" VALUES ('old','target');`);
            if (existsSync(migration))
                pg.sql(db, readFileSync(migration, 'utf8'));
            expect(pg.sql(db, `SELECT count(*) FROM information_schema.columns WHERE table_name='VehicleEventRule' AND column_name='selfControlEnabled'`)).toBe('1');
            expect(pg.sql(db, `SELECT "selfControlEnabled" FROM "VehicleEventRule" WHERE id='old'`)).toBe('f');
            pg.sql(db, `INSERT INTO "VehicleEventRule" (id,"sensorProtocol",status,"sourceCount","targetCount","selfControlEnabled") VALUES ('self','bio_usb_pulse','enabled',1,0,true);
    INSERT INTO "VehicleEventSource" VALUES ('self','own-source');SELECT "assert_vehicle_event_rule_has_source_and_target"('self');`);
            expect(() => pg.sql(db, `UPDATE "VehicleEventRule" SET "selfControlEnabled"=false WHERE id='self';SELECT "assert_vehicle_event_rule_has_source_and_target"('self')`)).toThrow();
            expect(() => pg.sql(db, `UPDATE "VehicleEventRule" SET "sensorProtocol"='bluez_stateful' WHERE id='self';SELECT "assert_vehicle_event_rule_has_source_and_target"('self')`)).toThrow();
            expect(() => pg.sql(db, `UPDATE "VehicleEventRule" SET "sourceCount"=2 WHERE id='self';SELECT "assert_vehicle_event_rule_has_source_and_target"('self')`)).toThrow();
            expect(() => pg.sql(db, `UPDATE "VehicleEventRule" SET "holdSeconds"=128 WHERE id='self'`)).toThrow();
            expect(() => pg.sql(db, `UPDATE "VehicleEventRule" SET "brightnessPercent"=0 WHERE id='self'`)).toThrow();
            pg.sql(db, `UPDATE "VehicleEventRule" SET "holdSeconds"=1 WHERE id='self'`);
            expect(pg.sql(db, `SELECT "holdSeconds" FROM "VehicleEventRule" WHERE id='self'`)).toBe('1');
            const freshDatabase = pg.database();
            const deployed = pg.deploy(freshDatabase);
            // CLI version notices are not migration errors. Keep stderr in the
            // failure projection without requiring a silent third-party CLI.
            expect({ status: deployed.status, error: deployed.status === 0 ? null : deployed.stderr }).toEqual({ status: 0, error: null });
            expect(pg.sql(freshDatabase, `SELECT "finished_at" IS NOT NULL FROM "_prisma_migrations" WHERE migration_name='20261016100000_bio_native_self_control'`)).toBe('t');
        }
        finally {
            pg.stop();
        }
    });
});
