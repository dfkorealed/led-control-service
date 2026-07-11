import { CommandDispatchService } from "./command-dispatch.service";

describe("CommandDispatchService", () => {
  it("splits fixture targets into one dispatch per gateway", () => {
    const service = new CommandDispatchService();
    const dispatches = service.groupByGateway([
      { fixtureId: "fixture-1", gatewayId: "gateway-1" },
      { fixtureId: "fixture-2", gatewayId: "gateway-2" },
      { fixtureId: "fixture-3", gatewayId: "gateway-1" }
    ]);

    expect(dispatches).toEqual([
      { gatewayId: "gateway-1", fixtureIds: ["fixture-1", "fixture-3"] },
      { gatewayId: "gateway-2", fixtureIds: ["fixture-2"] }
    ]);
  });

  it("rejects fixtures without a gateway mapping", () => {
    const service = new CommandDispatchService();
    expect(() => service.groupByGateway([{ fixtureId: "fixture-1", gatewayId: null }])).toThrow("gateway mapping");
  });
});
