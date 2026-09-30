import { Prisma, PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "./support/disposable-postgres";

// This opt-in suite only creates its own local cluster; it never uses DATABASE_URL.
const enabled = process.env.BIO_PULSE_SCHEMA_DISPOSABLE_POSTGRES === "1";
const migration = "20260930120000_bio_pulse_event_contract";

(enabled ? describe : describe.skip)("BIO pulse schema on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let databaseUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    databaseUrl = cluster.database();
    deploy(databaseUrl);
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  }, 60_000);
  afterAll(async () => { await prisma?.$disconnect(); cluster?.stop(); });

  function deploy(url: string, through?: string) {
    const result = cluster.deploy(url, through);
    if (result.status !== 0) throw new Error(result.stderr + result.stdout);
  }
  function sql(statement: string) { return cluster.sql(databaseUrl, statement); }
  function rejected(statement: string) {
    const result = spawnSync("psql", [databaseUrl, "-XAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", statement], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("23514");
  }

  async function scenario(client = prisma) {
    const suffix = randomUUID();
    const organization = await client.organization.create({ data: { name: suffix, type: "customer" } });
    const admin = await client.user.create({ data: {
      organizationId: organization.id, loginId: suffix, email: `${suffix}@example.com`,
      name: "Schema test", passwordHash: "unused", role: "admin"
    } });
    const site = await client.site.create({ data: { organizationId: organization.id, adminUserId: admin.id, name: suffix } });
    const floor = await client.floor.create({ data: { siteId: site.id, name: "B1", level: -1 } });
    const gateway = await client.gateway.create({ data: { siteId: site.id, name: suffix, serialNumber: suffix, firmwareVersion: "test" } });
    const nodes: string[] = [];
    const fixtures: string[] = [];
    for (let index = 0; index < 4; index++) {
      // Raw INSERT also exercises DB defaults and works against the pre-expand schema.
      const nodeId = randomUUID();
      await client.$executeRawUnsafe(`INSERT INTO "MeshNode" ("id", "gatewayId", "meshAddress", "firmwareVersion", "updatedAt")
        VALUES ('${nodeId}', '${gateway.id}', '010${index}', 'test', now())`);
      nodes.push(nodeId);
      const fixture = await client.fixture.create({ data: { floorId: floor.id, meshNodeId: nodeId, name: `Fixture ${index}`, ratedWatt: 20, x: index, y: 0 } });
      fixtures.push(fixture.id);
    }
    return { site: site.id, gateway: gateway.id, admin: admin.id, nodes, fixtures };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;
  function bluez(node: string) {
    return `UPDATE "MeshNode" SET "vehicleSensorCapabilityStatus"='supported',
      "vehicleSensorCapabilityVerifiedAt"=now(), "vehicleSensorCapabilityRevision"=1,
      "vehicleSensorServerBound"=true, "vehicleVendorEventModelBound"=true WHERE "id"='${node}';`;
  }
  function bio(node: string, readiness = "ready") {
    return `UPDATE "MeshNode" SET "vehicleSensorProtocol"='bio_usb_pulse', "bioPulseReadiness"='${readiness}',
      "bioPulseCapabilityRevision"=1, "bioPulseProfileId"='synthetic-test-profile', "bioPulseVerifiedAt"=now() WHERE "id"='${node}';`;
  }
  function rule(s: Scenario, id: string, protocol?: string, hold = 60, source = 0, status = "enabled") {
    return `INSERT INTO "VehicleEventRule" ("id","siteId","gatewayId","name","status","dimmingEnabled","brightnessPercent","holdSeconds","createdById","updatedById","updatedAt"${protocol ? ',"sensorProtocol"' : ''})
      VALUES ('${id}','${s.site}','${s.gateway}','test','${status}',true,80,${hold},'${s.admin}','${s.admin}',now()${protocol ? `,'${protocol}'` : ''});
      INSERT INTO "VehicleEventSource" ("ruleId","fixtureId","siteId","gatewayId") VALUES ('${id}','${s.fixtures[source]}','${s.site}','${s.gateway}');
      INSERT INTO "VehicleEventTarget" ("ruleId","fixtureId","siteId","gatewayId") VALUES ('${id}','${s.fixtures[3]}','${s.site}','${s.gateway}');`;
  }

  it("upgrades an existing enabled BlueZ 5-second rule without changing its capability or memberships", async () => {
    const legacyUrl = cluster.database();
    deploy(legacyUrl, "20260930");
    const client = new PrismaClient({ datasources: { db: { url: legacyUrl } } });
    try {
      const s = await scenario(client);
      cluster.sql(legacyUrl, `BEGIN; ${bluez(s.nodes[0])} ${rule(s, "legacy", undefined, 5)} COMMIT;`);
      deploy(legacyUrl, migration);
      const result = JSON.parse(cluster.sql(legacyUrl, `SELECT row_to_json(r) FROM "VehicleEventRule" r WHERE id='legacy'`));
      expect(result).toMatchObject({ sensorProtocol: "bluez_stateful", status: "enabled", holdSeconds: 5, sourceCount: 1, targetCount: 1 });
      const node = JSON.parse(cluster.sql(legacyUrl, `SELECT row_to_json(n) FROM "MeshNode" n WHERE id='${s.nodes[0]}'`));
      expect(node).toMatchObject({ vehicleSensorProtocol: "bluez_stateful", vehicleSensorCapabilityStatus: "supported",
        vehicleSensorCapabilityRevision: 1, vehicleSensorServerBound: true, vehicleVendorEventModelBound: true,
        bioPulseReadiness: "off", bioPulseCapabilityRevision: 0, bioPulseProfileId: null, bioPulseVerifiedAt: null });
    } finally { await client.$disconnect(); }
  }, 60_000);

  it("starts every new node with BIO OFF and does not invent model bindings", async () => {
    const s = await scenario();
    expect(JSON.parse(sql(`SELECT row_to_json(n) FROM "MeshNode" n WHERE id='${s.nodes[0]}'`)))
      .toMatchObject({ vehicleSensorProtocol: "bluez_stateful", bioPulseReadiness: "off", bioPulseProfileId: null,
        bioPulseVerifiedAt: null, bioPulseCapabilityRevision: 0, vehicleSensorServerBound: false, vehicleVendorEventModelBound: false });
    sql(`UPDATE "MeshNode" SET "vehicleSensorProtocol"='bio_usb_pulse' WHERE id='${s.nodes[0]}'`);
    expect(JSON.parse(sql(`SELECT row_to_json(n) FROM "MeshNode" n WHERE id='${s.nodes[0]}'`)))
      .toMatchObject({ vehicleSensorProtocol: "bio_usb_pulse", bioPulseReadiness: "off", bioPulseProfileId: null,
        bioPulseVerifiedAt: null, bioPulseCapabilityRevision: 0, vehicleSensorCapabilityStatus: "unknown" });
  });

  it("rejects legacy enabled-source drift with remediation details and rolls back the entire expansion", async () => {
    const legacyUrl = cluster.database();
    deploy(legacyUrl, "20260930");
    const client = new PrismaClient({ datasources: { db: { url: legacyUrl } } });
    const legacySql = (statement: string) => cluster.sql(legacyUrl, statement);
    try {
      const s = await scenario(client);
      // The old ruleId-only UPDATE path bypassed capability admission without
      // disabling a trigger. Both parents retain valid nonempty child counts.
      legacySql(`BEGIN; ${s.nodes.slice(0, 3).map(bluez).join(" ")}
        ${rule(s, "audit", undefined, 5, 0, "disabled")}
        INSERT INTO "VehicleEventSource" ("ruleId","fixtureId","siteId","gatewayId")
          VALUES ('audit','${s.fixtures[1]}','${s.site}','${s.gateway}');
        ${rule(s, "enabled-drift", undefined, 5, 2)} COMMIT;
        UPDATE "MeshNode" SET "vehicleSensorCapabilityStatus"='unsupported',
          "vehicleSensorCapabilityRevision"=2, "vehicleSensorServerBound"=false,
          "vehicleVendorEventModelBound"=false WHERE id='${s.nodes[0]}';
        UPDATE "VehicleEventSource" SET "ruleId"='enabled-drift'
          WHERE "ruleId"='audit' AND "fixtureId"='${s.fixtures[0]}';`);
      const snapshot = () => legacySql(`SELECT row_to_json(r) FROM "VehicleEventRule" r ORDER BY id;
        SELECT row_to_json(s) FROM "VehicleEventSource" s ORDER BY "ruleId", "fixtureId";
        SELECT row_to_json(n) FROM "MeshNode" n ORDER BY id;`);
      const before = snapshot();
      const triggerSnapshot = () => legacySql(`SELECT pg_get_triggerdef(oid) FROM pg_trigger
        WHERE tgrelid IN ('"VehicleEventRule"'::regclass, '"VehicleEventSource"'::regclass, '"Fixture"'::regclass, '"MeshNode"'::regclass)
        ORDER BY tgrelid, tgname`);
      const triggersBefore = triggerSnapshot();
      const result = cluster.deploy(legacyUrl, migration);
      expect(result.status).not.toBe(0);
      const diagnostic = result.stderr + result.stdout;
      expect(diagnostic).toContain("23514");
      expect(diagnostic).toContain("Operator remediation required before BIO pulse migration");
      expect(diagnostic).toContain("rule=enabled-drift");
      expect(diagnostic).toContain(`fixture=${s.fixtures[0]}`);
      expect(diagnostic).toContain(`node=${s.nodes[0]}`);
      expect(diagnostic).toContain("protocol=bluez_stateful");
      expect(diagnostic).toContain("status=unsupported");
      expect(diagnostic).toContain("Disable the affected rule or repair/remove its invalid source");
      expect(snapshot()).toBe(before);
      expect(triggerSnapshot()).toBe(triggersBefore);
      expect(legacySql(`SELECT count(*) FROM pg_type WHERE typname IN ('VehicleSensorProtocol', 'BioPulseReadiness')`)).toBe("0");
      expect(legacySql(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
        AND column_name IN ('sensorProtocol', 'vehicleSensorProtocol', 'bioPulseReadiness', 'bioPulseProfileId', 'bioPulseVerifiedAt', 'bioPulseCapabilityRevision')`)).toBe("0");
      expect(legacySql(`SELECT count(*) FROM pg_proc WHERE proname='vehicle_event_source_is_ready'`)).toBe("0");

      // Operator remediation is explicit. Disabled audit rows may remain as-is;
      // Prisma's failed-attempt ledger is resolved separately from the SQL rollback.
      legacySql(`UPDATE "VehicleEventRule" SET status='disabled' WHERE id='enabled-drift'`);
      expect(cluster.resolveRolledBack(legacyUrl, migration).status).toBe(0);
      deploy(legacyUrl, migration);
      expect(legacySql(`SELECT count(*) FROM information_schema.tables WHERE table_name='BioPulseMigrationFailure'`)).toBe("0");
      expect(legacySql(`SELECT "vehicleSensorCapabilityStatus" FROM "MeshNode" WHERE id='${s.nodes[0]}'`)).toBe("unsupported");
      expect(legacySql(`SELECT "sourceCount" FROM "VehicleEventRule" WHERE id='enabled-drift'`)).toBe("2");
    } finally { await client.$disconnect(); }
  }, 60_000);

  it.each([5, 9, 1801])("rejects BIO hold %i while retaining the BlueZ 5-second boundary", async (hold) => {
    const s = await scenario();
    sql(bio(s.nodes[0]));
    rejected(`BEGIN; ${rule(s, randomUUID(), "bio_usb_pulse", hold)} COMMIT;`);
  });
  it.each([10, 60, 1800])("accepts qualified BIO hold %i with false V1 model bindings", async (hold) => {
    const s = await scenario();
    sql(`BEGIN; ${bio(s.nodes[0])} ${rule(s, randomUUID(), "bio_usb_pulse", hold)} COMMIT;`);
  });

  it.each(["off", "shadow", "degraded"])("rejects source insertion for BIO %s even into a disabled rule", async (readiness) => {
    const s = await scenario();
    sql(bio(s.nodes[0], readiness));
    rejected(`BEGIN; ${rule(s, randomUUID(), "bio_usb_pulse", 60, 0, "disabled")} COMMIT;`);
  });
  it("enforces protocol-specific capability coherence without weakening BlueZ unsupported checks", async () => {
    const s = await scenario();
    for (const change of [
      `"vehicleSensorCapabilityStatus"='supported', "vehicleSensorCapabilityRevision"=1, "vehicleSensorCapabilityVerifiedAt"=now()`,
      `"vehicleSensorCapabilityStatus"='unsupported', "vehicleSensorCapabilityRevision"=1, "vehicleSensorServerBound"=true, "vehicleVendorEventModelBound"=true`,
      `"bioPulseReadiness"='ready', "bioPulseCapabilityRevision"=1, "bioPulseProfileId"='test', "bioPulseVerifiedAt"=now()`,
      `"vehicleSensorProtocol"='bio_usb_pulse', "bioPulseReadiness"='ready', "bioPulseCapabilityRevision"=1`,
      `"vehicleSensorProtocol"='bio_usb_pulse', "bioPulseReadiness"='ready', "bioPulseCapabilityRevision"=1, "bioPulseProfileId"=' ', "bioPulseVerifiedAt"=now()`,
      `"vehicleSensorProtocol"='bio_usb_pulse', "bioPulseReadiness"='ready', "bioPulseCapabilityRevision"=1, "bioPulseProfileId"=E'\\t\\n', "bioPulseVerifiedAt"=now()`,
      `"vehicleSensorProtocol"='bio_usb_pulse', "bioPulseReadiness"='shadow'`,
      `"vehicleSensorProtocol"='bio_usb_pulse', "bioPulseCapabilityRevision"=-1`
    ]) rejected(`UPDATE "MeshNode" SET ${change} WHERE id='${s.nodes[0]}'`);
    sql(bio(s.nodes[0]));
    rejected(bluez(s.nodes[0]));
  });

  it("guards enabled-source downgrade, disabled-source re-enable, and rule protocol changes", async () => {
    const s = await scenario();
    const id = randomUUID();
    sql(`BEGIN; ${bio(s.nodes[0])} ${rule(s, id, "bio_usb_pulse")} COMMIT;`);
    for (const readiness of ["off", "shadow", "degraded"])
      rejected(`UPDATE "MeshNode" SET "bioPulseReadiness"='${readiness}', "bioPulseCapabilityRevision"=2 WHERE id='${s.nodes[0]}'`);
    rejected(`UPDATE "VehicleEventRule" SET "sensorProtocol"='bluez_stateful' WHERE id='${id}'`);
    sql(`UPDATE "VehicleEventRule" SET status='disabled' WHERE id='${id}';
      UPDATE "MeshNode" SET "bioPulseReadiness"='degraded', "bioPulseCapabilityRevision"=2 WHERE id='${s.nodes[0]}'`);
    rejected(`UPDATE "VehicleEventRule" SET status='enabled' WHERE id='${id}'`);
    sql(`UPDATE "MeshNode" SET "bioPulseReadiness"='ready', "bioPulseCapabilityRevision"=3 WHERE id='${s.nodes[0]}';
      UPDATE "VehicleEventRule" SET status='enabled' WHERE id='${id}'`);
  });

  it("preserves all node and Fixture values while fencing source admission and re-enable", async () => {
    const s = await scenario();
    const id = randomUUID();
    sql(bio(s.nodes[0]));
    const state = () => sql(`SELECT row_to_json(n) FROM "MeshNode" n WHERE id='${s.nodes[0]}';
      SELECT row_to_json(f) FROM "Fixture" f WHERE id='${s.fixtures[0]}'`);
    const before = state();
    sql(`BEGIN; ${rule(s, id, "bio_usb_pulse")} COMMIT;
      UPDATE "VehicleEventRule" SET status='disabled' WHERE id='${id}';
      UPDATE "VehicleEventRule" SET status='enabled' WHERE id='${id}'`);
    expect(state()).toBe(before);
  });

  it("rejects mixed protocol source insertion and source moves to a different protocol rule", async () => {
    const s = await scenario();
    const bluezId = randomUUID(), bioId = randomUUID();
    sql(`BEGIN; ${bluez(s.nodes[0])} ${bio(s.nodes[1])} ${rule(s, bluezId)} ${rule(s, bioId, "bio_usb_pulse", 60, 1)} COMMIT;`);
    rejected(`INSERT INTO "VehicleEventSource" ("ruleId","fixtureId","siteId","gatewayId") VALUES ('${bluezId}','${s.fixtures[1]}','${s.site}','${s.gateway}')`);
    rejected(`UPDATE "VehicleEventSource" SET "ruleId"='${bioId}' WHERE "ruleId"='${bluezId}'`);
  });

  it("guards source Fixture reassignment and permits retaining a disabled rule for audit", async () => {
    const s = await scenario();
    const id = randomUUID();
    sql(`BEGIN; ${bio(s.nodes[0])} ${rule(s, id, "bio_usb_pulse")} COMMIT; DELETE FROM "Fixture" WHERE id='${s.fixtures[2]}';`);
    rejected(`UPDATE "Fixture" SET "meshNodeId"='${s.nodes[2]}' WHERE id='${s.fixtures[0]}'`);
    rejected(`UPDATE "Fixture" SET "meshNodeId"=NULL WHERE id='${s.fixtures[0]}'`);
    sql(`UPDATE "VehicleEventRule" SET status='disabled' WHERE id='${id}'; UPDATE "Fixture" SET "meshNodeId"='${s.nodes[2]}' WHERE id='${s.fixtures[0]}'`);
    rejected(`UPDATE "VehicleEventRule" SET status='enabled' WHERE id='${id}'`);
  });

  it.each(["ReadCommitted", "RepeatableRead", "Serializable"] as const)(
    "rejects downgrade/reassignment after a concurrent new source under %s", async (isolationLevel) => {
      for (const mutation of ["downgrade", "reassign"]) {
        const s = await scenario();
        sql(bio(s.nodes[0]));
        const outcome = await prisma.$transaction(async (tx) => {
          // Establish the old snapshot before the second connection creates the rule.
          await tx.$queryRaw`SELECT count(*) FROM "VehicleEventRule"`;
          sql(`BEGIN; ${rule(s, randomUUID(), "bio_usb_pulse")} COMMIT;`);
          const statement = mutation === "downgrade"
            ? `UPDATE "MeshNode" SET "bioPulseReadiness"='degraded', "bioPulseCapabilityRevision"=2 WHERE id='${s.nodes[0]}'`
            : `UPDATE "Fixture" SET "meshNodeId"=NULL WHERE id='${s.fixtures[0]}'`;
          await tx.$executeRawUnsafe(statement);
        }, { isolationLevel }).then(() => "unsafe_commit", (error: unknown) => databaseError(error));
        expect(["23514", "40001", "P2034"]).toContain(outcome);
      }
    }
  );

  it.each(["RepeatableRead", "Serializable"] as const)(
    "fences capability after concurrent re-enable or source reassignment under %s", async (isolationLevel) => {
      for (const admission of ["reenable", "reassign"]) {
        const s = await scenario();
        const id = randomUUID();
        sql(`BEGIN; ${bio(s.nodes[0])} ${bio(s.nodes[2])} ${rule(s, id, "bio_usb_pulse")} COMMIT;`);
        sql(admission === "reenable"
          ? `UPDATE "VehicleEventRule" SET status='disabled' WHERE id='${id}'`
          : `DELETE FROM "Fixture" WHERE id='${s.fixtures[2]}'`);
        const node = admission === "reenable" ? s.nodes[0] : s.nodes[2];
        const outcome = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT count(*) FROM "VehicleEventRule"`;
          sql(admission === "reenable"
            ? `UPDATE "VehicleEventRule" SET status='enabled' WHERE id='${id}'`
            : `UPDATE "Fixture" SET "meshNodeId"='${node}' WHERE id='${s.fixtures[0]}'`);
          await tx.$executeRawUnsafe(`UPDATE "MeshNode" SET "bioPulseReadiness"='degraded', "bioPulseCapabilityRevision"=2 WHERE id='${node}'`);
        }, { isolationLevel }).then(() => "unsafe_commit", (error: unknown) => databaseError(error));
        expect(["40001", "P2034"]).toContain(outcome);
      }
    }
  );

  it.each(["ReadCommitted", "RepeatableRead", "Serializable"] as const)(
    "rejects a source after concurrent downgrade/reassignment under %s", async (isolationLevel) => {
      for (const mutation of ["downgrade", "reassign"]) {
        const s = await scenario();
        sql(bio(s.nodes[0]));
        const outcome = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT count(*) FROM "VehicleEventRule"`;
          sql(mutation === "downgrade"
            ? `UPDATE "MeshNode" SET "bioPulseReadiness"='degraded', "bioPulseCapabilityRevision"=2 WHERE id='${s.nodes[0]}'`
            : `UPDATE "Fixture" SET "meshNodeId"=NULL WHERE id='${s.fixtures[0]}'`);
          for (const statement of rule(s, randomUUID(), "bio_usb_pulse").split(";").filter((part) => part.trim()))
            await tx.$executeRawUnsafe(statement);
        }, { isolationLevel }).then(() => "unsafe_commit", (error: unknown) => databaseError(error));
        expect(["23514", "40001", "P2034"]).toContain(outcome);
      }
    }
  );
});

function databaseError(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
  return error.meta?.code ?? error.code;
}
