import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const readSchema = () =>
  readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

const pkiMigrationSuffix = "_add_gateway_pki_lifecycle";
const activeEnrollmentMigrationSuffix = "_enforce_single_active_gateway_enrollment";
const activeMqttCertificateMigrationSuffix = "_enforce_single_active_mqtt_certificate";
const pendingDeviceCertificateStatusMigrationSuffix = "_add_pending_device_certificate_status";
const pendingDeviceCertificateLifecycleMigrationSuffix = "_enforce_pending_device_certificate_lifecycle";
const roleRevisionMigrationSuffix = "simplify_roles_and_floor_revisions";

const findPkiMigrationDirectory = (directoryNames: string[]) => {
  const matches = directoryNames.filter((name) => name.endsWith(pkiMigrationSuffix));

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one *${pkiMigrationSuffix} migration directory, found ${matches.length}: ${matches.join(", ")}`
    );
  }

  return matches[0];
};

const readPkiMigration = () => {
  const migrationsPath = join(process.cwd(), "prisma/migrations");
  const migrationDirectory = findPkiMigrationDirectory(
    readdirSync(migrationsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  );

  return readFileSync(join(migrationsPath, migrationDirectory, "migration.sql"), "utf8");
};

const readMigrationBySuffix = (suffix: string) => {
  const migrationsPath = join(process.cwd(), "prisma/migrations");
  const matches = readdirSync(migrationsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(suffix))
    .map((entry) => entry.name);

  if (matches.length !== 1) {
    throw new Error(`Expected exactly one *${suffix} migration directory, found ${matches.length}: ${matches.join(", ")}`);
  }

  return readFileSync(join(migrationsPath, matches[0], "migration.sql"), "utf8");
};

const forbiddenPkiSecretField =
  /(?:private.*key|key.*private|(?:certificate|cert).*(?:pem|der|body|content|blob|bytes)|(?:pem|der).*(?:certificate|cert)|(?:raw|plain(?:text)?|secret).*(?:token|claim.*code)|(?:token|claim.*code).*(?:raw|plain(?:text)?|secret)|claim.*code(?!hash$))/i;

const prismaModelBody = (schema: string, modelName: string) => {
  const body = schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`))?.[1];

  if (!body) {
    throw new Error(`Prisma model ${modelName} is missing`);
  }

  return body;
};

interface PrismaStorageField {
  modelName: string;
  fieldName: string;
  type: "Bytes" | "String";
}

const prismaStorageFields = (schema: string): PrismaStorageField[] =>
  [...schema.matchAll(/^model\s+(\w+)\s+\{([\s\S]*?)^\}/gm)].flatMap((modelMatch) => {
    const modelName = modelMatch[1];
    const modelBody = modelMatch[2];

    return modelBody.split("\n").flatMap((line) => {
      const fieldMatch = line.trim().match(/^(\w+)\s+(String|Bytes)(?:\?|\[\])?(?:\s|$)/);
      if (!fieldMatch) return [];

      return [{ modelName, fieldName: fieldMatch[1], type: fieldMatch[2] as "Bytes" | "String" }];
    });
  });

describe("Prisma domain schema", () => {
  it("declares the production tenant role and revision contract", () => {
    const schema = readSchema();

    expect(schema).toMatch(/enum UserRole\s*\{\s*operator\s+admin\s+viewer\s*\}/);
    expect(schema).not.toMatch(/enum UserRole\s*\{[^}]*owner/);
    expect(schema).toContain("enum OrganizationType");
    expect(schema).toContain("model SiteMembership");
    expect(schema).toContain("@@unique([userId, siteId])");
    expect(schema).toContain("mapRevision");
    expect(schema).toContain("model FloorMapRevision");
    expect(schema).toMatch(/snapshot\s+Json/);
    expect(schema).toContain("model AuditLog");
  });

  it("keeps every legacy organization as a customer and demotes legacy privileged roles", () => {
    const migration = readMigrationBySuffix(roleRevisionMigrationSuffix);

    expect(migration).toContain('CREATE TYPE "OrganizationType" AS ENUM (\'service_provider\', \'customer\')');
    expect(migration).toContain(
      'ADD COLUMN "type" "OrganizationType" NOT NULL DEFAULT \'customer\''
    );
    expect(migration).not.toMatch(/UPDATE "Organization"[\s\S]*?EXISTS[\s\S]*?"Site"/);
    expect(migration).not.toMatch(/THEN 'service_provider'/);
    expect(migration).toMatch(/WHEN (?:u\.)?"role"::text IN \('owner', 'operator', 'admin'\) THEN 'admin'/);
    expect(migration).not.toMatch(/THEN 'operator'/);
    expect(migration).not.toMatch(/ALTER TABLE "User"[\s\S]*?ALTER COLUMN "role"[\s\S]*?USING \([\s\S]*?EXISTS/);
    expect(migration).toMatch(/INSERT INTO "SiteMembership"[\s\S]*?WHERE u\."role" = 'viewer' AND o\."type" = 'customer'/);
    expect(migration).toContain('ALTER TABLE "Floor" ADD COLUMN "mapRevision" INTEGER NOT NULL DEFAULT 0');
    expect(migration).toContain('CREATE TABLE "FloorMapRevision"');
    expect(migration).toContain('CREATE TABLE "AuditLog"');
  });

  it("preserves legacy admin roles for users and invitations during conversion", () => {
    const migration = readMigrationBySuffix(roleRevisionMigrationSuffix);

    expect(migration).toContain(
      'WHEN u."role"::text IN (\'owner\', \'operator\', \'admin\') THEN \'admin\''
    );
    expect(migration).toContain(
      'WHEN "role"::text IN (\'owner\', \'operator\', \'admin\') THEN \'admin\''
    );
    expect(migration).toMatch(/WHEN u\."role"::text IN \([\s\S]*?\) THEN 'admin'[\s\S]*?ELSE 'viewer'/);
    expect(migration).toMatch(/WHEN "role"::text IN \([\s\S]*?\) THEN 'admin'[\s\S]*?ELSE 'viewer'/);
  });

  it("enforces one service provider organization in PostgreSQL", () => {
    const migration = readMigrationBySuffix(roleRevisionMigrationSuffix);

    expect(migration).toContain(
      'CREATE UNIQUE INDEX "Organization_single_service_provider_key" ON "Organization"("type") WHERE "type" = \'service_provider\''
    );
  });

  it("declares the MVP 1 lighting control domain models", () => {
    const schema = readSchema();

    for (const model of [
      "Organization",
      "User",
      "Site",
      "Floor",
      "FloorPlan",
      "Fixture",
      "FixtureGroup",
      "Gateway",
      "MeshNode",
      "Command",
      "EnergyUsage"
    ]) {
      expect(schema).toContain(`model ${model}`);
    }
  });

  it("declares production gateway identity, dispatch, and ordered event records", () => {
    const schema = readSchema();

    for (const model of [
      "GatewayInventory",
      "GatewayClaimAudit",
      "CommandDispatch",
      "CommandFixtureResult",
      "MqttOutbox",
      "ProcessedGatewayEvent"
    ]) {
      expect(schema).toContain(`model ${model}`);
    }

    for (const field of [
      "claimCodeHash",
      "certificateFingerprint",
      "assignmentVersion",
      "nextCommandSequence",
      "lastStateEventId",
      "lastStateSequence",
      "idempotencyKey"
    ]) {
      expect(schema).toContain(field);
    }
  });

  it("declares the gateway PKI enrollment and certificate lifecycle ledger", () => {
    const schema = readSchema();

    expect(schema).toContain("model GatewayEnrollment");
    expect(schema).toContain("tokenHash");
    expect(schema).toContain("model GatewayCertificate");
    expect(schema).toContain("certificateSerial");
    expect(schema).toContain("fingerprint");

    expect(prismaModelBody(schema, "GatewayInventory")).toMatch(
      /certificateFingerprint\s+String\?\s+@unique/
    );
    expect(prismaModelBody(schema, "Gateway")).toMatch(
      /\/\/\/ Active device certificate fingerprint pointer; canonical history is GatewayCertificate\.fingerprint\.\s+certificateFingerprint\s+String\?/
    );
    expect(prismaModelBody(schema, "GatewayInventory")).toMatch(
      /\/\/\/ Active device certificate fingerprint pointer; canonical history is GatewayCertificate\.fingerprint\.\s+certificateFingerprint\s+String\?/
    );
    expect(prismaModelBody(schema, "GatewayCertificate")).toMatch(
      /\/\/\/ Canonical certificate fingerprint ledger; Gateway and GatewayInventory point to the active device certificate\.\s+fingerprint\s+String/
    );
    expect(schema).toMatch(/purpose\s+CertificatePurpose/);
    expect(schema).toMatch(/status\s+GatewayCertificateStatus/);
    expect(schema).toContain("@@unique([issuer, certificateSerial])");
    expect(schema).toMatch(
      /inventory\s+GatewayInventory\s+@relation\(fields: \[inventoryId\], references: \[id\], onDelete: Restrict\)/
    );
    expect(schema).toMatch(
      /gateway\s+Gateway\?\s+@relation\(fields: \[gatewayId\], references: \[id\], onDelete: SetNull\)/
    );
    expect(schema).toMatch(
      /replacedBy\s+GatewayCertificate\?\s+@relation\("GatewayCertificateReplacement", fields: \[replacedById\], references: \[id\], onDelete: Restrict\)/
    );
  });

  it("enforces the gateway PKI lifecycle in the migration", () => {
    const migration = readPkiMigration();

    expect(migration).toContain('CREATE TYPE "CertificatePurpose" AS ENUM (\'device\', \'mqtt\')');
    expect(migration).toContain(
      'CREATE TYPE "GatewayCertificateStatus" AS ENUM (\'active\', \'replaced\', \'revoked\', \'expired\')'
    );
    expect(migration).toMatch(
      /ALTER TABLE "GatewayInventory"\s+ALTER COLUMN "certificateFingerprint" DROP NOT NULL/
    );
    expect(migration).toContain(
      'CONSTRAINT "GatewayCertificate_not_self_replaced_check" CHECK ("replacedById" IS NULL OR "replacedById" <> "id")'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "GatewayCertificate_issuer_certificateSerial_key" ON "GatewayCertificate"("issuer", "certificateSerial")'
    );
    expect(migration).toMatch(
      /GatewayCertificate_inventoryId_fkey[\s\S]*?ON DELETE RESTRICT ON UPDATE CASCADE/
    );
    expect(migration).toMatch(
      /GatewayCertificate_replacedById_fkey[\s\S]*?ON DELETE RESTRICT ON UPDATE CASCADE/
    );
  });

  it("enforces one unused enrollment per serial with a PostgreSQL partial unique index", () => {
    const migration = readMigrationBySuffix(activeEnrollmentMigrationSuffix);

    expect(migration).toContain(
      'CREATE UNIQUE INDEX "GatewayEnrollment_single_active_serial_key" ON "GatewayEnrollment"("serialNumber") WHERE "usedAt" IS NULL'
    );
    expect(migration).not.toMatch(/tokenHash.*(?:sha256|md5|digest)/i);
  });

  it("enforces one active MQTT certificate per inventory with a PostgreSQL partial unique index", () => {
    const migration = readMigrationBySuffix(activeMqttCertificateMigrationSuffix);

    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "GatewayCertificate_single_active_mqtt_inventory_key"\s+ON "GatewayCertificate"\("inventoryId"\)\s+WHERE "purpose" = 'mqtt' AND "status" = 'active'/
    );
  });

  it("separates the pending enum addition from pending certificate repairs and indexes", () => {
    const enumMigration = readMigrationBySuffix(pendingDeviceCertificateStatusMigrationSuffix);
    const lifecycleMigration = readMigrationBySuffix(pendingDeviceCertificateLifecycleMigrationSuffix);

    expect(enumMigration.trim()).toBe('ALTER TYPE "GatewayCertificateStatus" ADD VALUE IF NOT EXISTS \'pending\';');
    expect(lifecycleMigration).not.toContain('ALTER TYPE "GatewayCertificateStatus" ADD VALUE');
    expect(lifecycleMigration).toMatch(/"status" = 'pending'/);
    expect(lifecycleMigration).toMatch(
      /CREATE UNIQUE INDEX "GatewayCertificate_single_active_device_inventory_key"\s+ON "GatewayCertificate"\("inventoryId"\)\s+WHERE "purpose" = 'device' AND "status" = 'active'/
    );
    expect(lifecycleMigration).toMatch(
      /CREATE UNIQUE INDEX "GatewayCertificate_single_pending_device_inventory_key"\s+ON "GatewayCertificate"\("inventoryId"\)\s+WHERE "purpose" = 'device' AND "status" = 'pending'/
    );
  });

  it("rejects ambiguous gateway PKI lifecycle migration discovery", () => {
    expect(() =>
      findPkiMigrationDirectory([
        "20260715100000_add_gateway_pki_lifecycle",
        "20260715110000_add_gateway_pki_lifecycle"
      ])
    ).toThrow("Expected exactly one *_add_gateway_pki_lifecycle migration directory, found 2");
  });

  it("does not persist PKI secret material in String or Bytes fields across the schema", () => {
    const schema = readSchema();
    const migration = readPkiMigration();
    const pkiModelNames = [
      "Gateway",
      "GatewayInventory",
      "GatewayEnrollment",
      "GatewayCertificate"
    ];
    const storageFields = prismaStorageFields(schema);
    const pkiStorageFields = storageFields.filter(({ modelName }) =>
      pkiModelNames.includes(modelName)
    );
    const migrationIdentifiers = [...migration.matchAll(/"([^"]+)"/g)].map(
      (match) => match[1]
    );
    const riskySchemaFields = storageFields.filter(({ fieldName }) =>
      forbiddenPkiSecretField.test(fieldName.replace(/_/g, "").toLowerCase())
    );
    const riskyMigrationIdentifiers = migrationIdentifiers.filter((fieldName) =>
      forbiddenPkiSecretField.test(fieldName.replace(/_/g, "").toLowerCase())
    );

    expect([...new Set(pkiStorageFields.map(({ modelName }) => modelName))].sort()).toEqual(
      [...pkiModelNames].sort()
    );
    expect(riskySchemaFields).toEqual([]);
    expect(riskyMigrationIdentifiers).toEqual([]);
  });
});
