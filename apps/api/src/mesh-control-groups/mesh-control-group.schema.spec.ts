import { readFileSync } from "node:fs";
import { join } from "node:path";

const schemaPath = join(__dirname, "../../prisma/schema.prisma");
const initialMigrationPath = join(
  __dirname,
  "../../prisma/migrations/20260819093000_add_mesh_control_groups/migration.sql"
);
const statusVersionMigrationPath = join(
  __dirname,
  "../../prisma/migrations/20260821093000_add_mesh_control_group_member_status_version/migration.sql"
);
const operationPlanMigrationPath = join(
  __dirname,
  "../../prisma/migrations/20260826190000_persist_mesh_group_operation_plans/migration.sql"
);
const fullReconciliationMigrationPath = join(
  __dirname,
  "../../prisma/migrations/20260826203000_add_mesh_group_full_reconciliation/migration.sql"
);

describe("MeshControlGroup schema contract", () => {
  const schema = readFileSync(schemaPath, "utf8");
  const migration = readFileSync(initialMigrationPath, "utf8");
  const statusVersionMigration = readFileSync(statusVersionMigrationPath, "utf8");
  const operationPlanMigration = readFileSync(operationPlanMigrationPath, "utf8");
  const fullReconciliationMigration = readFileSync(fullReconciliationMigrationPath, "utf8");
  const meshControlGroupModel = schema.match(/model MeshControlGroup \{[\s\S]*?\n\}/)?.[0] ?? "";
  const meshControlGroupMemberModel = schema.match(/model MeshControlGroupMember \{[\s\S]*?\n\}/)?.[0] ?? "";

  it("persists a version-bound operation plan and the cloud applied membership snapshot", () => {
    expect(meshControlGroupModel).toMatch(/operationPlanVersion\s+Int\s+@default\(0\)/);
    expect(meshControlGroupModel).toMatch(/fullReconciliationRequired\s+Boolean\s+@default\(false\)/);
    expect(schema).toContain("model MeshControlGroupExpectedOperation {");
    expect(schema).toContain("model MeshControlGroupAppliedMember {");
    expect(schema).toMatch(/configurationVersion\s+Int/);
    expect(schema).toMatch(/@@unique\(\[groupId, configurationVersion, action, meshNodeId, meshAddress\]\)/);
    expect(schema).toMatch(/@@id\(\[groupId, meshNodeId, meshAddress\]\)/);
    expect(operationPlanMigration).toContain('ADD COLUMN "operationPlanVersion" INTEGER NOT NULL DEFAULT 0');
    expect(operationPlanMigration).toContain('CREATE TABLE "MeshControlGroupExpectedOperation"');
    expect(operationPlanMigration).toContain('CREATE TABLE "MeshControlGroupAppliedMember"');
    expect(operationPlanMigration).toContain('"MeshControlGroupExpectedOperation_groupId_gatewayId_fkey"');
    expect(operationPlanMigration).toContain('WHERE member."appliedVersion" > 0');
    expect(fullReconciliationMigration).toContain(
      'ADD COLUMN "fullReconciliationRequired" BOOLEAN NOT NULL DEFAULT false'
    );
  });

  it("stores group configurationVersion instead of a generic version field", () => {
    expect(meshControlGroupModel).toMatch(/configurationVersion\s+Int\s+@default\(1\)/);
    expect(meshControlGroupModel).not.toMatch(/\n\s+version\s+Int\s+@default\(1\)/);
    expect(migration).toContain('"configurationVersion" INTEGER NOT NULL DEFAULT 1');
    expect(migration).not.toContain('"version" INTEGER NOT NULL DEFAULT 1');
  });

  it("stores member subscription status and appliedVersion with an initial unapplied default", () => {
    expect(schema).toContain("enum MeshControlGroupMemberSubscriptionStatus");
    expect(schema).toMatch(/subscriptionStatus\s+MeshControlGroupMemberSubscriptionStatus\s+@default\(pending\)/);
    expect(schema).toMatch(/appliedVersion\s+Int\s+@default\(0\)/);
    expect(schema).toMatch(/statusVersion\s+Int\s+@default\(0\)/);
    expect(migration).toContain('CREATE TYPE "MeshControlGroupMemberSubscriptionStatus" AS ENUM');
    expect(migration).toContain('"subscriptionStatus" "MeshControlGroupMemberSubscriptionStatus" NOT NULL DEFAULT \'pending\'');
    expect(migration).toContain('"appliedVersion" INTEGER NOT NULL DEFAULT 0');
    expect(statusVersionMigration).toContain('ALTER TABLE "MeshControlGroupMember" ADD COLUMN "statusVersion" INTEGER NOT NULL DEFAULT 0;');
  });

  it("binds members to the same gateway as both the group and the mesh node without limiting one group to one node", () => {
    expect(meshControlGroupMemberModel).toMatch(/gatewayId\s+String/);
    expect(schema).toContain("@@unique([id, gatewayId])");
    expect(schema).toContain("@@unique([id, gatewayId])");
    expect(meshControlGroupMemberModel).not.toContain("@@unique([groupId, gatewayId])");
    expect(meshControlGroupMemberModel).not.toContain("@@unique([meshNodeId, gatewayId])");
    expect(meshControlGroupMemberModel).toContain("@@index([groupId, gatewayId])");
    expect(meshControlGroupMemberModel).toContain("@@index([meshNodeId, gatewayId])");
    expect(meshControlGroupMemberModel).toMatch(
      /group\s+MeshControlGroup\s+@relation\(fields: \[groupId, gatewayId\], references: \[id, gatewayId\], onDelete: Cascade\)/
    );
    expect(meshControlGroupMemberModel).toMatch(
      /meshNode\s+MeshNode\s+@relation\(fields: \[meshNodeId, gatewayId\], references: \[id, gatewayId\], onDelete: Cascade\)/
    );
    expect(migration).toContain('CREATE UNIQUE INDEX "MeshControlGroup_id_gatewayId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "MeshNode_id_gatewayId_key"');
    expect(migration).not.toContain('CREATE UNIQUE INDEX "MeshControlGroupMember_groupId_gatewayId_key"');
    expect(migration).not.toContain('CREATE UNIQUE INDEX "MeshControlGroupMember_meshNodeId_gatewayId_key"');
    expect(migration).toContain('CREATE INDEX "MeshControlGroupMember_groupId_gatewayId_idx"');
    expect(migration).toContain('CREATE INDEX "MeshControlGroupMember_meshNodeId_gatewayId_idx"');
    expect(migration).toContain('"MeshControlGroupMember_groupId_gatewayId_fkey"');
    expect(migration).toContain('"MeshControlGroupMember_meshNodeId_gatewayId_fkey"');
  });

  it("allows one mesh node to keep multiple memberships such as floor and fixture_group within the same gateway", () => {
    expect(meshControlGroupMemberModel).not.toContain("@@unique([meshNodeId, gatewayId])");
    expect(migration).not.toContain('CREATE UNIQUE INDEX "MeshControlGroupMember_meshNodeId_gatewayId_key"');
    expect(meshControlGroupMemberModel).toContain("@@id([groupId, meshNodeId])");
  });
});
