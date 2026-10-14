import { useEffect, useRef, useState } from "react";
import { applyBioRegistrationRevalidation, getBioRegistrationRevalidation, requestBioRegistrationRevalidation, type BioRegistrationRevalidationView } from "../../../../api/registration";
import type { DashboardFixture } from "../../../../api/queries";
import { Button, Text } from "../../../../components/ui";

/** Repair the current audited registration only. A mode GET or successful apply
 * must never grant sensor eligibility, change brightness, or activate a rule. */
export function BioRegistrationConnectionCheck({ siteId, fixture, disabled, canPrepare, onRefreshSource }: {
  siteId: string; fixture: DashboardFixture; disabled: boolean; canPrepare: boolean;
  onRefreshSource?: () => Promise<unknown>;
}) {
  const [receipt, setReceipt] = useState<BioRegistrationRevalidationView | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const busy = useRef(false); const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdentity = useRef<string | null>(null);
  const gatewayId = fixture.gateway?.id;
  const assignmentVersion = fixture.gateway?.assignmentVersion;
  const allowed = canPrepare && !disabled && fixture.status === "online" && fixture.gateway?.connectionStatus === "online"
    && Number.isSafeInteger(assignmentVersion) && (assignmentVersion ?? 0) > 0;
  const scope = JSON.stringify([siteId, fixture.id, gatewayId, assignmentVersion, allowed]);
  // Fence immediately during render as well as effect cleanup: a pending GET
  // cannot apply a proof after site, binding, permission or online state changes.
  const currentScope = useRef(scope); currentScope.current = scope;
  useEffect(() => {
    generation.current++; busy.current = false; requestIdentity.current = null;
    setReceipt(null); setPending(false); setMessage(""); setError("");
    if (timer.current) clearTimeout(timer.current);
    return () => { generation.current++; if (timer.current) clearTimeout(timer.current); };
  }, [scope]);
  const isCurrent = (current: number, key: string) => current === generation.current && currentScope.current === key;

  function validate(value: BioRegistrationRevalidationView, commandId?: string) {
    if (value.siteId !== siteId || value.gatewayId !== gatewayId || value.fixtureId !== fixture.id
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.commandId)
      || (commandId && value.commandId !== commandId)
      || !["pending", "observed", "unknown", "timed_out"].includes(value.status)
      || ![value.requestedAt, value.expiresAt, value.applyDeadlineAt].every(v => Number.isFinite(Date.parse(v)))
      || (value.appliedAt !== null && !Number.isFinite(Date.parse(value.appliedAt)))) throw new Error("scope");
    return value;
  }

  async function confirmApplied(value: BioRegistrationRevalidationView, current: number, key: string) {
    if (!value.appliedAt || value.supersededAt || value.status !== "observed") throw new Error("unconfirmed");
    await onRefreshSource?.();
    if (isCurrent(current, key)) setMessage("등록 연결 확인 완료 · 최신 준비 상태를 확인한 뒤 센서 사용을 설정하세요.");
  }

  async function read(commandId: string, current: number, key: string, attempts: number) {
    let scheduled = false;
    try {
      const result = await getBioRegistrationRevalidation(commandId);
      if (!isCurrent(current, key)) return;
      validate(result, commandId); setReceipt(result);
      if (result.supersededAt) throw new Error("superseded");
      if (result.appliedAt) await confirmApplied(result, current, key);
      else if (result.status === "pending") {
        if (attempts < 5 && Date.parse(result.expiresAt) > Date.now()) {
          timer.current = setTimeout(() => { timer.current = null; void read(commandId, current, key, attempts + 1); }, 1_000);
          scheduled = true; return;
        }
        setMessage("등록 연결 확인 대기 · 요청 결과를 다시 조회해 주세요.");
      } else if (result.status === "observed") {
        if (!result.observedMode || !["sensor", "force-on", "force-off"].includes(result.observedMode)
          || Date.parse(result.applyDeadlineAt) <= Date.now()) throw new Error("proof_expired");
        // This is the existing authorized, idempotent audit/apply endpoint, not
        // a direct DB repair. Unknown apply outcomes resume by GET, not new RF.
        const applied = await applyBioRegistrationRevalidation(commandId);
        if (!isCurrent(current, key)) return;
        validate(applied, commandId); setReceipt(applied);
        await confirmApplied(applied, current, key);
      } else setMessage("등록 연결을 확인하지 못했습니다. 연결 상태를 점검한 뒤 다시 확인하세요.");
    } catch {
      if (isCurrent(current, key)) setError("등록 연결 확인을 완료하지 못했습니다. 요청 결과와 현재 연결 상태를 다시 확인해 주세요.");
    } finally {
      if (isCurrent(current, key) && !scheduled) { busy.current = false; setPending(false); }
    }
  }
  async function start() {
    if (!allowed || busy.current || !gatewayId || !assignmentVersion) return;
    const current = generation.current, key = scope;
    busy.current = true; setPending(true); setMessage("등록 연결 확인 대기"); setError("");
    if (timer.current) clearTimeout(timer.current); timer.current = null;
    const clientRequestId = requestIdentity.current ?? crypto.randomUUID(); requestIdentity.current = clientRequestId;
    try {
      const result = await requestBioRegistrationRevalidation({ siteId, gatewayId, fixtureId: fixture.id, expectedAssignmentVersion: assignmentVersion, clientRequestId });
      if (!isCurrent(current, key)) return;
      validate(result); setReceipt(result); requestIdentity.current = null;
      await read(result.commandId, current, key, 1);
    } catch {
      if (isCurrent(current, key)) { busy.current = false; setPending(false); setError("등록 연결 확인 요청을 확인하지 못했습니다. 같은 요청으로 다시 시도해 주세요."); }
    }
  }
  function resume() {
    if (!allowed || busy.current || !receipt) return;
    busy.current = true; setPending(true); setError("");
    if (timer.current) clearTimeout(timer.current); timer.current = null;
    void read(receipt.commandId, generation.current, scope, 5);
  }
  const canRestart = !receipt || receipt.status === "unknown" || receipt.status === "timed_out" || Date.parse(receipt.applyDeadlineAt) <= Date.now();
  return <div className="grid min-w-0 gap-2" role="group" aria-label={`${fixture.name} 등록 연결 확인`}>
    <Text variant="caption">기존 조명 ID·기본 밝기를 유지하며 등록 연결을 확인합니다. 센서 사용 설정은 별도로 진행합니다.</Text>
    {!Number.isSafeInteger(assignmentVersion) || (assignmentVersion ?? 0) <= 0 ? <Text variant="caption">최신 게이트웨이 배정 정보를 다시 조회해 주세요.</Text> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="secondary" disabled={!allowed || pending || !canRestart} onClick={() => void start()}>등록 연결 확인</Button>
      {receipt ? <Button type="button" variant="secondary" disabled={!allowed || pending} onClick={resume}>등록 확인 결과 조회</Button> : null}
    </div>
    {message ? <Text aria-live="polite">{message}</Text> : null}
    {error ? <Text role="alert" tone="danger">{error}</Text> : null}
  </div>;
}
