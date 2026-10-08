import { useEffect, useRef, useState } from "react";
import { getBioSensorPreparation, requestBioSensorPreparation, type BioSensorPreparationOperation, type VehicleEventSourceBlockReason } from "../../../api/automation";
import type { DashboardFixture } from "../../../api/queries";
import { Button, Card, Text } from "../../../components/ui";

export const bioSensorReasonLabels: Record<VehicleEventSourceBlockReason, string> = {
  profile_unverified: "호환 프로파일 확인 필요 · 승인된 장비군과 대조해야 합니다.",
  fingerprint_unverified: "장비 식별 확인 필요 · 현재 등록 장비의 식별 정보가 미확인입니다.",
  mode_unverified: "센서 모드 확인 필요 · 센서 사용 설정 또는 준비 상태 확인을 실행하세요.",
  link_unverified: "연결 확인 필요 · 현재 독립 연결 응답이 미확인입니다.",
  catalog_pending: "호환 정보 전달 대기 · 게이트웨이의 현재 수용 확인이 필요합니다.",
  operating_policy_required: "현장 운영 정책 필요 · 관리자가 장애 대응 담당자와 조치를 설정해야 합니다.",
  gateway_protocol_unverified: "게이트웨이 지원 확인 필요 · 현재 프로토콜 지원이 미확인입니다.",
  binding_changed: "등록 연결 재확인 필요 · 장비 또는 현장 배정 정보가 변경되었습니다.",
  unsupported: "지원하지 않음 · 확인된 장비 지원 범위를 점검해 주세요.",
  product_gate_off: "제품 지원 OFF · 현재 화면에서 BIO 규칙을 저장할 수 없습니다.",
  capability_unverified: "차량 감지 기능이 확인되지 않았습니다."
};
export function bioSensorBlockSummary(fixture: DashboardFixture) {
  const reasons = fixture.bioSensorPreparation?.blockedReasons ?? fixture.vehicleEventSource?.blockReasons ?? [];
  return reasons.map(reason => bioSensorReasonLabels[reason] ?? "서버에서 사용을 제한했습니다.").join(" ") || "서버가 사용 가능으로 확인한 센서만 선택할 수 있습니다.";
}

export function BioSensorPreparationPanel({ siteId, fixture, disabled, canPrepare = false, onRefreshSource, onSelectSource }: {
  siteId: string; fixture: DashboardFixture; disabled: boolean; canPrepare?: boolean;
  onRefreshSource?: () => Promise<unknown>; onSelectSource?: (fixtureId: string) => void;
}) {
  const [receipt, setReceipt] = useState<BioSensorPreparationOperation | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [awaitingProjection, setAwaitingProjection] = useState(false);
  const generation = useRef(0); const busy = useRef(false); const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdentity = useRef<{ operation: "query" | "ensure_sensor"; clientRequestId: string } | null>(null);
  const projection = fixture.bioSensorPreparation;
  const eligible = fixture.vehicleEventSource?.sourceEligible === true;
  const candidate = projection?.preparationCandidate === true;
  const reasons = projection?.blockedReasons ?? fixture.vehicleEventSource?.blockReasons ?? [];
  const evidenceKey = JSON.stringify([siteId, fixture.id, fixture.gateway?.id, projection?.preparationCandidate, projection?.status,
    projection?.commandId, projection?.profileKey, projection?.observedAt, [...(projection?.blockedReasons ?? [])].sort(),
    fixture.vehicleEventSource?.sourceEligible, fixture.vehicleEventSource?.readiness, fixture.vehicleEventSource?.modeVerification, canPrepare]);
  useEffect(() => {
    generation.current += 1; busy.current = false; setPending(false); setAwaitingProjection(false); setReceipt(null); setError(""); setMessage(""); requestIdentity.current = null;
    if (timer.current) clearTimeout(timer.current);
    return () => { generation.current += 1; if (timer.current) clearTimeout(timer.current); };
  }, [evidenceKey]);

  async function refresh(current: number) {
    if (generation.current !== current) return;
    try { await onRefreshSource?.(); }
    catch { if (generation.current === current) setError("최신 서버 상태를 확인하지 못했습니다. 준비 상태를 다시 조회해 주세요."); }
  }

  async function read(commandId: string, current: number, attempts: number) {
    if (generation.current !== current) return;
    try {
      const result = await getBioSensorPreparation(commandId);
      if (generation.current !== current) return;
      // A sanitized GET is only the initial checkpoint. Eligibility always comes
      // from the refreshed dashboard and its current independent live evidence.
      if (result.siteId !== siteId || result.fixtureId !== fixture.id || result.commandId !== commandId) throw new Error("scope");
      setReceipt(result);
      if (result.status === "pending" && !result.supersededAt && attempts < 5 && Date.parse(result.expiresAt) > Date.now()) {
        timer.current = setTimeout(() => void read(commandId, current, attempts + 1), 1_000);
        return;
      }
      setMessage(result.status === "ready" ? "준비 작업 확인 · 현재 서버 사용 가능 상태를 다시 확인합니다."
        : result.status === "pending" ? "자동 확인을 마쳤습니다. 요청 결과를 수동으로 확인하세요."
        : result.status === "failed" || result.status === "timed_out" ? "준비 작업을 완료하지 못했습니다. 연결과 준비 상태를 확인해 주세요."
        : "준비 작업 결과를 확인했습니다. 차단 사유와 현재 서버 상태를 확인해 주세요.");
      busy.current = false; setPending(false); await refresh(current);
    } catch {
      if (generation.current === current) { busy.current = false; setPending(false); setError("센서 준비를 확인하지 못했습니다. 요청 결과를 다시 확인해 주세요."); }
    }
  }

  async function run(operation: "query" | "ensure_sensor") {
    if (busy.current || disabled || !canPrepare || !candidate) return;
    const current = generation.current; busy.current = true; setPending(true); setAwaitingProjection(true); setError(""); setMessage("준비 확인 대기 · 아직 사용 가능 상태가 아닙니다.");
    // Keep the same request identity after an unknown POST outcome so retry cannot
    // duplicate a hardware write. A completed receipt permits a new operation.
    const identity = requestIdentity.current?.operation === operation ? requestIdentity.current : { operation, clientRequestId: crypto.randomUUID() };
    requestIdentity.current = identity;
    try {
      const result = await requestBioSensorPreparation({ siteId, fixtureId: fixture.id, ...identity });
      if (generation.current !== current) return;
      if (result.siteId !== siteId || result.fixtureId !== fixture.id) throw new Error("scope");
      setReceipt({ ...result, status: "pending", modeVerified: false, linkVerified: false });
      requestIdentity.current = null;
      // A new checkpoint supersedes older readiness. Refresh immediately after
      // acceptance; a changed public projection fences this generation. Its
      // command remains available below for explicit GET continuation.
      await refresh(current);
      await read(result.commandId, current, 1);
    } catch {
      if (generation.current === current) { busy.current = false; setPending(false); setError("센서 준비 요청을 확인하지 못했습니다. 같은 요청으로 다시 시도해 주세요."); }
    }
  }

  const resultCommandId = receipt?.commandId ?? projection?.commandId;
  const statusLabel = eligible && !awaitingProjection ? "사용 가능" : reasons.includes("unsupported") ? "지원하지 않음" : reasons.includes("profile_unverified") || reasons.includes("fingerprint_unverified") ? "호환 확인 필요" : reasons.includes("link_unverified") || projection?.status === "degraded" ? "연결 확인 필요" : "설정 필요";
  return <Card role="region" aria-label={`${fixture.name} 센서 준비`} className="grid min-w-0 gap-2 p-3">
    <Text weight="semibold">{fixture.name} · {statusLabel}</Text>
    {reasons.map(reason => <Text key={reason} variant="caption" tone="secondary">{bioSensorReasonLabels[reason] ?? "서버에서 사용을 제한했습니다."}</Text>)}
    {!candidate ? <Text variant="caption">현재 등록 연결에서 준비 작업을 사용할 수 없습니다. 관리자가 등록·호환 정보를 확인해야 합니다.</Text> : null}
    <Text variant="caption">감지 센서 자체의 자율 점등은 유지합니다. 아래 밝기 설정은 실행 조명에만 적용하며 자체 밝기 동작은 현장 검증 전입니다.</Text>
    {!canPrepare ? <Text variant="caption">센서 사용 설정과 준비 확인은 현장 관리자에게 요청하세요.</Text> : null}
    {message ? <Text aria-live="polite">{message}</Text> : null}
    {!message && projection?.status === "pending" ? <Text aria-live="polite">서버 준비 확인 대기 · 요청 결과를 확인하세요.</Text> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="secondary" disabled={disabled || pending || !canPrepare || !candidate} onClick={() => void run("ensure_sensor")}>센서 사용 설정</Button>
      <Button type="button" variant="secondary" disabled={disabled || pending || !canPrepare || !candidate} onClick={() => void run("query")}>준비 상태 확인</Button>
      {resultCommandId ? <Button type="button" variant="secondary" disabled={disabled || pending || !canPrepare} onClick={() => { if (busy.current) return; busy.current = true; setPending(true); setError(""); void read(resultCommandId, generation.current, 5); }}>요청 결과 확인</Button> : null}
      {onRefreshSource ? <Button type="button" variant="secondary" disabled={disabled || pending} onClick={() => void refresh(generation.current)}>준비 상태 다시 조회</Button> : null}
      {onSelectSource ? <Button type="button" disabled={disabled || pending || awaitingProjection || !eligible} onClick={() => onSelectSource(fixture.id)}>감지 센서로 선택</Button> : null}
    </div>
    {error ? <Text role="alert" tone="danger">{error}</Text> : null}
  </Card>;
}
