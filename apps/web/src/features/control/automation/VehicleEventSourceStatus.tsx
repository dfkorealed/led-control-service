import { useEffect, useRef, useState } from "react";
import { getSensorModeOperation, requestSensorMode, type SensorModeVerification, type VehicleEventSourceBlockReason } from "../../../api/automation";
import type { DashboardFixture } from "../../../api/queries";
import { Button, Card, Text } from "../../../components/ui";

const reasonLabels: Record<VehicleEventSourceBlockReason, string> = {
  product_gate_off: "제품 지원 OFF · 현재 화면에서 BIO 규칙을 저장할 수 없습니다.",
  mode_unverified: "센서 모드 GET 미확인 · 센서 모드 설정 또는 상태 재조회가 필요합니다.",
  capability_unverified: "차량 감지 기능이 확인되지 않았습니다."
};
const readinessLabels = { off: "사용 불가", shadow: "검증 중", ready: "사용 가능", degraded: "재검증 필요" };

export function VehicleEventSourceStatus({ siteId, fixture, disabled, onRefreshSource }: {
  siteId: string; fixture: DashboardFixture; disabled: boolean; onRefreshSource?: () => Promise<unknown>;
}) {
  const source = fixture.vehicleEventSource;
  const evidence = source?.modeVerification;
  const evidenceKey = JSON.stringify([source?.sensorProtocol, evidence?.commandId, evidence?.status, evidence?.modeVerified, evidence?.verifiedAt]);
  const [operation, setOperation] = useState<(SensorModeVerification & { evidenceKey: string }) | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  // Compare evidence values, not object references: a repeated older dashboard
  // must not cancel a legitimate in-flight command. Changed authoritative evidence
  // invalidates both the local affordance and late responses from its generation.
  useEffect(() => { generation.current += 1; setOperation(null); setPending(false); setError(""); return () => { generation.current += 1; }; }, [siteId, fixture.id, evidenceKey]);
  if (source?.sensorProtocol !== "bio-usb-pulse") return null;
  const mode = (operation?.evidenceKey === evidenceKey ? operation : null) ?? source.modeVerification;
  const serverCommandId = source.modeVerification.commandId;

  async function refreshSource() {
    if (pending || disabled || !onRefreshSource) return;
    const current = generation.current;
    setPending(true); setError("");
    try { await onRefreshSource(); }
    catch { if (generation.current === current) setError("최신 서버 상태를 확인하지 못했습니다. 준비 상태를 다시 조회해 주세요."); }
    finally { if (generation.current === current) setPending(false); }
  }

  async function receiveResult(commandId: string, status: string, current: number) {
    if (generation.current !== current) return;
    // A command GET is historical evidence only. Dashboard projection rechecks
    // the latest command and physical/assignment identity before displaying it.
    setOperation({ commandId, status: status === "pending" ? "pending" : "awaiting_source", modeVerified: false, verifiedAt: null, evidenceKey });
    await onRefreshSource?.();
  }

  async function refreshResult() {
    if (!mode.commandId || pending || disabled) return;
    const current = generation.current;
    setPending(true); setError("");
    try {
      const result = await getSensorModeOperation(mode.commandId);
      await receiveResult(result.commandId, result.status, current);
    } catch {
      if (generation.current === current) setError("센서 모드를 확인하지 못했습니다. 상태를 다시 조회해 주세요.");
    } finally {
      if (generation.current === current) setPending(false);
    }
  }

  async function run(kind: "ensure_sensor" | "query") {
    if (pending || disabled) return;
    const current = generation.current;
    setPending(true); setError("");
    // POST acceptance is not mode evidence. A separate GET triggers a dashboard
    // refresh; only its current-identity projection can display historical proof.
    setOperation({ commandId: null, status: "pending", modeVerified: false, verifiedAt: null, evidenceKey });
    try {
      const requested = await requestSensorMode({ siteId, fixtureId: fixture.id, clientRequestId: crypto.randomUUID(), operation: kind,
        ...(kind === "query" && serverCommandId ? { requeryOfCommandId: serverCommandId } : {}) });
      if (generation.current !== current) return;
      setOperation({ commandId: requested.commandId, status: "pending", modeVerified: false, verifiedAt: null, evidenceKey });
      const result = await getSensorModeOperation(requested.commandId);
      await receiveResult(result.commandId, result.status, current);
    } catch {
      if (generation.current === current) setError("센서 모드를 확인하지 못했습니다. 상태를 다시 조회해 주세요.");
    } finally {
      if (generation.current === current) setPending(false);
    }
  }

  return <Card className="grid min-w-0 gap-2 p-3" aria-label={`${fixture.name} BIO 센서 상태`}>
    <Text weight="semibold">{fixture.name} · BIO A · {readinessLabels[source.readiness]}</Text>
    {source.capabilityEvidence === "shadow" ? <Text>검증 중 · 관찰 보고만 수집하며 제어 준비 완료가 아닙니다.</Text> : null}
    {source.capabilityEvidence === "degraded" || source.readiness === "degraded" ? <Text tone="danger" role="alert">재검증 필요 · 센서 장애 보고가 있습니다. 자동 복원 여부를 확인하고 운영자가 조치해야 합니다.</Text> : null}
    {source.blockReasons.map(reason => <Text key={reason} tone="secondary">{reasonLabels[reason] ?? "서버에서 사용을 제한했습니다."}</Text>)}
    <Text>센서 전용 A는 센서 모드를 유지합니다. 자체 밝기 동작은 현장 검증 전이며, 아래 밝기는 실행 조명 B에만 적용됩니다.</Text>
    <Text aria-live="polite">{mode.modeVerified && mode.verifiedAt ? `센서 모드 GET 확인 시점: ${mode.verifiedAt} · 과거 확인 기록이며 현재 사용 준비를 보장하지 않습니다.`
      : mode.status === "awaiting_source" ? "최신 서버 상태 확인 중 · 모드 GET 결과를 현재 장비 정보와 대조해야 합니다."
      : mode.status === "pending" ? "센서 모드 확인 대기 · 아직 사용 준비가 확인되지 않았습니다." : "센서 모드 GET 미확인"}</Text>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="secondary" disabled={disabled || pending} onClick={() => void run("ensure_sensor")}>센서 모드 설정</Button>
      <Button type="button" variant="secondary" disabled={disabled || pending} onClick={() => void run("query")}>상태 재조회</Button>
      {mode.commandId && mode.status === "pending" ? <Button type="button" variant="secondary" disabled={disabled || pending} onClick={() => void refreshResult()}>요청 결과 확인</Button> : null}
      {mode.status === "awaiting_source" && onRefreshSource ? <Button type="button" variant="secondary" disabled={disabled || pending} onClick={() => void refreshSource()}>준비 상태 다시 조회</Button> : null}
    </div>
    {error ? <Text tone="danger" role="alert">{error}</Text> : null}
  </Card>;
}
