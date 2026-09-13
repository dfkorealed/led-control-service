import { lockRegistrationDomain } from "./registration-domain-locks";

describe("lockRegistrationDomain", () => {
  it("keeps concurrent request, publisher, and terminal callers in one deterministic order", async () => {
    const calls = new Map<string, string[]>();
    const transaction = (label: string) => ({
      $queryRaw: jest.fn(async (sql: TemplateStringsArray) => {
        await Promise.resolve();
        const text = sql.join(" ");
        const table = ["Floor", "Gateway", "ProvisioningSession", "DiscoveredMeshNode", "ProvisioningDeviceOutbox"]
          .find((candidate) => text.includes(`"${candidate}"`));
        calls.get(label)!.push(table ?? "unknown");
        return [];
      })
    });
    const scope = {
      floorId: "10000000-0000-4000-8000-000000000001",
      gatewayId: "10000000-0000-4000-8000-000000000002",
      sessionId: "10000000-0000-4000-8000-000000000003",
      nodeIds: ["10000000-0000-4000-8000-000000000004"],
      outboxIds: ["10000000-0000-4000-8000-000000000005"]
    };

    for (const label of ["request", "publisher", "terminal"]) calls.set(label, []);
    await Promise.all([...calls.keys()].map((label) => (
      lockRegistrationDomain(transaction(label) as never, scope)
    )));

    const expected = ["Floor", "Gateway", "ProvisioningSession", "DiscoveredMeshNode", "ProvisioningDeviceOutbox"];
    expect(calls.get("request")).toEqual(expected);
    expect(calls.get("publisher")).toEqual(expected);
    expect(calls.get("terminal")).toEqual(expected);
  });

  it("sorts and deduplicates node and outbox locks", async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    await lockRegistrationDomain(tx as never, {
      floorId: "floor",
      gatewayId: "gateway",
      sessionId: "session",
      nodeIds: ["node-b", "node-a", "node-b"],
      outboxIds: ["outbox-b", "outbox-a", "outbox-b"]
    });

    expect(tx.$queryRaw.mock.calls[3][1]).toBe("session");
    expect(tx.$queryRaw.mock.calls[3][2].values).toEqual(["node-a", "node-b"]);
    expect(tx.$queryRaw.mock.calls[4][1].values).toEqual(["outbox-a", "outbox-b"]);
  });
});
