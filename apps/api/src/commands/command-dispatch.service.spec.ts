import { CommandDispatchService } from "./command-dispatch.service";

describe("CommandDispatchService", () => {
  it("returns one sorted single-gateway fixture set", () => {
    const service = new CommandDispatchService();
    const dispatch = service.resolveSingleGateway([
      { fixtureId: "fixture-2", gatewayId: "gateway-1" },
      { fixtureId: "fixture-1", gatewayId: "gateway-1" }
    ]);

    expect(dispatch).toEqual({ gatewayId: "gateway-1", fixtureIds: ["fixture-1", "fixture-2"] });
  });

  it("rejects fixtures without a gateway or across multiple gateways", () => {
    const service = new CommandDispatchService();
    expect(() => service.resolveSingleGateway([{ fixtureId: "fixture-1", gatewayId: null }])).toThrow("gateway mapping");
    expect(() => service.resolveSingleGateway([
      { fixtureId: "fixture-1", gatewayId: "gateway-1" },
      { fixtureId: "fixture-2", gatewayId: "gateway-2" }
    ])).toThrow("현재 여러 게이트웨이에 걸친 대상은 지원하지 않습니다");
  });
});
