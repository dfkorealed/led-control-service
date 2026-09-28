import { recordCommandOutcomeActivity } from "./command-outcome-activity";

const commandId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const fixtureIds = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const floorIds = ["55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"];

function harness() {
  const tx: any = {
    command: { findUnique: jest.fn().mockResolvedValue({ siteId, targetFixtureIds: fixtureIds }) },
    fixture: { findMany: jest.fn().mockResolvedValue([{ floorId: floorIds[0] }, { floorId: floorIds[1] }]) },
    floor: { findMany: jest.fn(async ({ where }: any) => where.id.in.map((id: string) => ({ id }))) },
    monitoringActivity: { createMany: jest.fn().mockResolvedValue({ count: 2 }) }
  };
  return tx;
}

describe("command outcome activity", () => {
  it("records an actual unknown then verified applied result once per impacted floor", async () => {
    const tx = harness();
    await recordCommandOutcomeActivity(tx, commandId, "pending", "unknown");
    expect(tx.monitoringActivity.createMany).toHaveBeenCalledWith({ data: floorIds.map(floorId => ({
      siteId, floorId, sourceType: "command", sourceKey: `${commandId}:unknown`,
      kind: "command_result", commandOutcome: "unknown"
    })), skipDuplicates: true });
    await recordCommandOutcomeActivity(tx, commandId, "unknown", "applied");
    expect(tx.monitoringActivity.createMany).toHaveBeenCalledTimes(2);
    expect(tx.monitoringActivity.createMany.mock.calls[1][0].data).toEqual(floorIds.map(floorId => ({
      siteId, floorId, sourceType: "command", sourceKey: `${commandId}:applied`,
      kind: "command_result", commandOutcome: "applied"
    })));
  });

  it("does not fabricate an unchanged, pending, or unscoped outcome", async () => {
    const tx = harness();
    await recordCommandOutcomeActivity(tx, commandId, "unknown", "unknown");
    await recordCommandOutcomeActivity(tx, commandId, "pending", "pending");
    expect(tx.command.findUnique).not.toHaveBeenCalled();
    tx.fixture.findMany.mockResolvedValue([]);
    await recordCommandOutcomeActivity(tx, commandId, "pending", "not_applied");
    expect(tx.monitoringActivity.createMany).not.toHaveBeenCalled();
  });
});
