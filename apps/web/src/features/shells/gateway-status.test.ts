import { describe, expect, it } from "vitest";
import type { Dashboard } from "../../api/queries";
import { deriveGatewayAggregate } from "./gateway-status";

type Gateway = Dashboard["gateways"][number];
const gateway = (id: string, connectionStatus: Gateway["connectionStatus"]): Gateway => ({
  id,
  name: `Gateway ${id}`,
  serialNumber: `serial-${id}`,
  firmwareVersion: "1.0.0",
  lastHeartbeatAt: "2026-09-24T00:00:00.000Z",
  connectionStatus
});

describe("deriveGatewayAggregate", () => {
  it("keeps unavailable distinct from offline", () => {
    expect(deriveGatewayAggregate({ gateways: undefined, error: new Error("private") })).toMatchObject({
      kind: "unavailable",
      tone: "neutral",
      label: "게이트웨이 확인 불가",
      compactLabel: "확인 불가"
    });
  });

  it("reports an explicitly empty gateway list as unregistered", () => {
    expect(deriveGatewayAggregate({ gateways: [], error: null })).toMatchObject({
      kind: "unregistered",
      tone: "neutral",
      label: "게이트웨이 미등록",
      online: 0,
      total: 0
    });
  });

  it.each([
    [[gateway("1", "online")], "healthy", "게이트웨이 1/1대 연결", "1/1"],
    [[gateway("1", "online"), gateway("2", "offline")], "attention", "게이트웨이 1/2대 연결 · 확인 필요", "1/2"],
    [[gateway("1", "offline"), gateway("2", "offline")], "attention", "게이트웨이 0/2대 연결 · 확인 필요", "0/2"]
  ] as const)("aggregates selected-site gateway connectivity", (gateways, kind, label, compactLabel) => {
    expect(deriveGatewayAggregate({ gateways: [...gateways], error: null })).toMatchObject({ kind, label, compactLabel });
  });

  it("keeps cached counts but marks a background refresh failure as delayed", () => {
    expect(deriveGatewayAggregate({ gateways: [gateway("1", "online")], error: new Error("refresh") })).toMatchObject({
      kind: "stale",
      tone: "warning",
      label: "게이트웨이 1/1대 연결 · 갱신 지연",
      compactLabel: "1/1 지연"
    });
  });
});
