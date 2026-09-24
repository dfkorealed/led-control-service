import type { Dashboard } from "../../api/queries";
import type { StatusTone } from "../../components/ui";

export interface GatewayAggregate {
  kind: "unavailable" | "unregistered" | "healthy" | "attention" | "stale";
  tone: StatusTone;
  label: string;
  compactLabel: string;
  online: number;
  total: number;
}

export function deriveGatewayAggregate({ gateways, error }: { gateways: Dashboard["gateways"] | undefined; error: unknown }): GatewayAggregate {
  if (!gateways) return { kind: "unavailable", tone: "neutral", label: "게이트웨이 확인 불가", compactLabel: "확인 불가", online: 0, total: 0 };
  const total = gateways.length;
  const online = gateways.filter((gateway) => gateway.connectionStatus === "online").length;
  if (error) return { kind: "stale", tone: "warning", label: `게이트웨이 ${online}/${total}대 연결 · 갱신 지연`, compactLabel: `${online}/${total} 지연`, online, total };
  if (total === 0) return { kind: "unregistered", tone: "neutral", label: "게이트웨이 미등록", compactLabel: "미등록", online, total };
  if (online === total) return { kind: "healthy", tone: "success", label: `게이트웨이 ${online}/${total}대 연결`, compactLabel: `${online}/${total}`, online, total };
  return { kind: "attention", tone: "warning", label: `게이트웨이 ${online}/${total}대 연결 · 확인 필요`, compactLabel: `${online}/${total}`, online, total };
}
