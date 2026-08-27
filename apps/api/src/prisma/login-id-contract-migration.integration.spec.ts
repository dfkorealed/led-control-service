import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("login id contract migration", () => {
  const apiRoot = join(__dirname, "../..");
  const schema = readFileSync(join(apiRoot, "prisma/schema.prisma"), "utf8");
  const migrationPath = join(apiRoot, "prisma/migrations/20260827100000_login_id_contract/migration.sql");
  const migration = readFileSync(migrationPath, "utf8");

  it("makes loginId required and email nullable in Prisma", () => {
    expect(schema).toMatch(/loginId\s+String\s+@unique/);
    expect(schema).toMatch(/email\s+String\?\s+@unique/);
  });

  it("re-backfills null login ids before validating and enforcing the final contract", () => {
    expect(migration).toContain('WHERE "loginId" IS NULL AND "email" IS NOT NULL');
    expect(migration).toContain('SET "loginId" = lower(btrim("email"))');
    expect(migration).toContain("invalid loginId format before contract enforcement");
    expect(migration).toContain("loginId collision before contract enforcement");
    expect(migration).toContain("loginId remains null before contract enforcement");
    expect(migration).toContain('ALTER COLUMN "loginId" SET NOT NULL');
    expect(migration).toContain('ALTER COLUMN "email" DROP NOT NULL');
    expect(migration.indexOf('SET "loginId" = lower(btrim("email"))')).toBeLessThan(migration.indexOf('ALTER COLUMN "loginId" SET NOT NULL'));
  });
});
