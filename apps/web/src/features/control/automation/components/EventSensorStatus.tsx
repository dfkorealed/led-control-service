import { CircleCheck, TriangleAlert } from "lucide-react";
import type { DashboardFixture } from "../../../../api/queries";
import { StatusBadge } from "../../../../components/ui";

/** Keep user-facing status compact. Runtime reports cover all rules sharing a
 * source: they may warn, but never establish this rule's execution or readiness. */
export function EventSensorStatus({ name, ready, sources }: {
  name: string;
  ready: boolean;
  sources: DashboardFixture[];
}) {
  const needsInspection = sources.some(source => source.vehicleEventSource?.readiness === "degraded"
    || source.vehicleEventSource?.capabilityEvidence === "degraded"
    || source.bioPulseTelemetry?.health === "degraded" || Boolean(source.bioPulseTelemetry?.degradedSince));
  const restorationReported = sources.some(source => source.bioPulseTelemetry?.restorationPending === true);
  return <div role="group" aria-label={`${name} 센서 상태`} className="flex min-w-0 flex-wrap justify-end gap-1 pt-1">
    <StatusBadge tone={ready ? "success" : "warning"} icon={ready ? CircleCheck : TriangleAlert}>
      {ready ? "센서 준비 완료" : "준비 확인 필요"}
    </StatusBadge>
    {needsInspection ? <StatusBadge role="alert" tone="danger" icon={TriangleAlert}>센서 점검 필요</StatusBadge> : null}
    {restorationReported ? <StatusBadge role="alert" tone="warning" icon={TriangleAlert}
      title="연결된 센서의 다른 이벤트를 포함한 보고입니다. 실제 조명의 복귀 상태를 확인해 주세요.">
      센서 보고: 복귀 확인 필요
    </StatusBadge> : null}
  </div>;
}
