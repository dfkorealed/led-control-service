import { Prisma } from "@prisma/client";

// Stateful database boundary for service tests; production history rules stay in the service.
export function createEnergyHistoryTestStore() {
  const identities: Array<{ id: string; siteId: string; fixtureId: string; trackingStartedAt: Date }> = [];
  const versions: Array<{
    id: string; energyFixtureId: string; name: string; floorId: string; floorName: string;
    ratedWatt: Prisma.Decimal; effectiveFrom: Date; effectiveTo: Date | null;
  }> = [];
  let sequence = 0;
  const addIdentity = (data: any) => {
    const row = { id: `identity-${++sequence}`, ...data };
    identities.push(row);
    return row;
  };
  const addVersion = (data: any) => {
    const row = { id: `version-${++sequence}`, effectiveTo: null, ...data };
    versions.push(row);
    return row;
  };
  const tx = {
    $executeRaw: jest.fn(async () => 0),
    energyFixtureIdentity: {
      findUnique: jest.fn(async ({ where }: any) => identities.find((row) => row.fixtureId === where.fixtureId) ?? null),
      findMany: jest.fn(async ({ where }: any) => identities.filter((row) =>
        (!where.siteId || row.siteId === where.siteId) && where.fixtureId.in.includes(row.fixtureId))),
      create: jest.fn(async ({ data }: any) => addIdentity(data)),
      createMany: jest.fn(async ({ data }: any) => {
        data.forEach(addIdentity);
        return { count: data.length };
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const removed = identities.filter((row) => where.id.in.includes(row.id));
        for (const row of removed) identities.splice(identities.indexOf(row), 1);
        for (const row of versions.filter((item) => where.id.in.includes(item.energyFixtureId))) {
          versions.splice(versions.indexOf(row), 1);
        }
        return { count: removed.length };
      })
    },
    energyFixtureDimensionVersion: {
      findFirst: jest.fn(async ({ where }: any) => versions.find((row) =>
        row.energyFixtureId === where.energyFixtureId && row.effectiveTo === null) ?? null),
      findMany: jest.fn(async ({ where }: any) => versions.filter((row) =>
        where.energyFixtureId.in.includes(row.energyFixtureId) && row.effectiveTo === null)),
      create: jest.fn(async ({ data }: any) => addVersion(data)),
      createMany: jest.fn(async ({ data }: any) => {
        data.forEach(addVersion);
        return { count: data.length };
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(versions.find((row) => row.id === where.id)!, data)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const changed = versions.filter((row) => where.id.in.includes(row.id));
        changed.forEach((row) => Object.assign(row, data));
        return { count: changed.length };
      })
    }
  };
  const queries = [tx.$executeRaw, ...Object.values(tx.energyFixtureIdentity), ...Object.values(tx.energyFixtureDimensionVersion)];
  return { tx, identities, versions, queryCount: () => queries.reduce((count, query) => count + query.mock.calls.length, 0) };
}
