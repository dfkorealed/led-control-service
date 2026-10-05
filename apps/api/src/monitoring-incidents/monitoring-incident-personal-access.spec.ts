import { Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { lockIncidentPersonalAccess } from "./monitoring-incident-personal-access";

describe("personal incident authorization", () => {
  const user: AuthenticatedUser = { id: "viewer", organizationId: "org", organizationType: "customer",
    role: "viewer", status: "active", mustChangePassword: false, name: "viewer", loginId: "viewer" };
  function fixture(patch: Record<string, unknown> = {}, membership = true) {
    const locks: string[] = [];
    const tx = {
      $queryRaw: async (sql: Prisma.Sql) => { locks.push(/FROM "(\w+)"/.exec(sql.sql)![1]); return [{ id: "site" }]; },
      user: { findUnique: async () => ({ ...user, organization: { type: "customer" }, ...patch }) },
      site: { findUnique: async () => ({ id: "site", organizationId: "org", adminUserId: null,
        memberships: membership ? [{ id: "membership", accessLevel: "read" }] : [] }) }
    } as unknown as Prisma.TransactionClient;
    return { locks, run: () => lockIncidentPersonalAccess(tx, user, "site", new SiteAccessService(tx as PrismaService)) };
  }
  it("allows read-only viewers and takes Site then User then membership locks", async () => {
    const { run, locks } = fixture(); await expect(run()).resolves.toBeUndefined();
    expect(locks).toEqual(["Site", "User", "SiteMembership"]);
  });
  it.each([{ status: "disabled" }, { role: "admin" }, { organizationId: "other" }, { organization: { type: "service_provider" } }])(
    "rejects persisted actor mismatch %p", async patch => { await expect(fixture(patch).run()).rejects.toMatchObject({ status: 404 }); });
  it("rejects missing membership", async () => { await expect(fixture({}, false).run()).rejects.toMatchObject({ status: 404 }); });
  it("rejects persisted password change requirement", async () => {
    await expect(fixture({ mustChangePassword: true }).run()).rejects.toMatchObject({ status: 403 });
  });
});
