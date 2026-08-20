import { readFileSync } from "node:fs";
import { join } from "node:path";

const schemaPath = join(__dirname, "../../prisma/schema.prisma");
const migrationPath = join(
  __dirname,
  "../../prisma/migrations/20260819093000_add_mesh_control_groups/migration.sql"
);

describe("MeshControlGroup schema contract", () => {
  const schema = readFileSync(schemaPath, "utf8");
  const migration = readFileSync(migrationPath, "utf8");
  const meshControlGroupModel = schema.match(/model MeshControlGroup \{[\s\S]*?\n\}/)?.[0] ?? "";

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
    expect(migration).toContain('CREATE TYPE "MeshControlGroupMemberSubscriptionStatus" AS ENUM');
    expect(migration).toContain('"subscriptionStatus" "MeshControlGroupMemberSubscriptionStatus" NOT NULL DEFAULT \'pending\'');
    expect(migration).toContain('"appliedVersion" INTEGER NOT NULL DEFAULT 0');
  });

  it("binds members to the same gateway as both the group and the mesh node", () => {
    expect(schema).toContain("gatewayId       String");
    expect(schema).toContain("@@unique([id, gatewayId])");
    expect(schema).toContain("@@unique([groupId, gatewayId])");
    expect(schema).toContain("@@unique([id, gatewayId])");
    expect(schema).toContain("@@unique([meshNodeId, gatewayId])");
    expect(schema).toMatch(
      /group\s+MeshControlGroup\s+@relation\(fields: \[groupId, gatewayId\], references: \[id, gatewayId\], onDelete: Cascade\)/
    );
    expect(schema).toMatch(
      /meshNode\s+MeshNode\s+@relation\(fields: \[meshNodeId, gatewayId\], references: \[id, gatewayId\], onDelete: Cascade\)/
    );
    expect(migration).toContain('CREATE UNIQUE INDEX "MeshControlGroup_id_gatewayId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "MeshNode_id_gatewayId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "MeshControlGroupMember_groupId_gatewayId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "MeshControlGroupMember_meshNodeId_gatewayId_key"');
    expect(migration).toContain('"MeshControlGroupMember_groupId_gatewayId_fkey"');
    expect(migration).toContain('"MeshControlGroupMember_meshNodeId_gatewayId_fkey"');
  });
});
