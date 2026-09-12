import { useEffect, useId, useRef, useState } from "react";
import { getMonitoringErrorCode, useMonitoringPolicy, useMonitoringPolicyMutation } from "../../api/monitoring-incidents";
import { Button, ModalDialog } from "../../components/ui";

export function MonitoringPolicyDialog({ siteId, onClose, onSaved }: { siteId: string; onClose: () => void; onSaved?: () => void }) {
  const query = useMonitoringPolicy(siteId);
  const mutation = useMonitoringPolicyMutation(siteId);
  const [draft, setDraft] = useState<{ gateway: string; fixture: string; revision: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reviewedRevision, setReviewedRevision] = useState<string | null>(null);
  const [conflictedRevision, setConflictedRevision] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const formId = useId();
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current && query.data) {
      initialized.current = true;
      setDraft({ gateway: String(query.data.gatewayOfflineAfterSeconds), fixture: String(query.data.fixtureStaleAfterSeconds), revision: query.data.updatedAt });
    }
  }, [query.data]);
  const ready = draft !== null;
  useEffect(() => { if (ready) firstInputRef.current?.focus(); }, [ready]);
  const latestAvailable = Boolean(query.data && !query.error && query.data.updatedAt !== conflictedRevision);
  const reviewed = Boolean(reviewedRevision && reviewedRevision === query.data?.updatedAt);
  const blocked = mutation.isPending || !draft || conflict && (!reviewed || !latestAvailable);

  async function save() {
    if (pendingRef.current || blocked || !draft) return;
    const gateway = Number(draft.gateway);
    const fixture = Number(draft.fixture);
    if (!draft.gateway.trim() || !Number.isInteger(gateway) || gateway < 30 || gateway > 900 || !draft.fixture.trim() || !Number.isInteger(fixture) || fixture < 60 || fixture > 3600) {
      setError("게이트웨이는 30~900초, 조명은 60~3600초 범위의 정수로 입력하세요.");
      firstInputRef.current?.focus();
      return;
    }
    pendingRef.current = true;
    setError(null);
    const expectedUpdatedAt = conflict ? reviewedRevision! : draft.revision;
    try {
      await mutation.mutateAsync({ gatewayOfflineAfterSeconds: gateway, fixtureStaleAfterSeconds: fixture, expectedUpdatedAt });
      onSaved?.();
      onClose();
    } catch (failure) {
      if (getMonitoringErrorCode(failure) === "MONITORING_POLICY_CONFLICT") {
        setConflict(true);
        setConflictedRevision(expectedUpdatedAt);
        setReviewedRevision(null);
        setError("다른 사용자가 판정 기준을 변경했습니다. 입력값을 유지했습니다. 최신 서버 기준을 재검토한 뒤 저장하세요.");
      } else setError("판정 기준을 저장하지 못했습니다. 연결과 권한을 확인한 뒤 다시 시도하세요.");
    } finally { pendingRef.current = false; }
  }
  return <ModalDialog title="판정 기준" description="현장의 모니터링 장애 판정 시간입니다. 장비 제어·등록의 안전 기준은 별도로 유지됩니다." onClose={onClose} isPending={mutation.isPending} initialFocusRef={firstInputRef} className="monitoring-policy-dialog" actions={<>
    <Button disabled={mutation.isPending} onClick={onClose}>취소</Button>
    <Button variant="primary" type="submit" form={formId} disabled={Boolean(blocked)} isLoading={mutation.isPending}>저장</Button>
  </>}>
    {query.isPending && <p role="status">판정 기준을 불러오는 중</p>}
    {query.error && <div role="alert"><p>{query.data ? "저장된 판정 기준을 유지하고 있습니다. 갱신에 실패했습니다." : "판정 기준을 불러오지 못했습니다."}</p><Button disabled={query.isFetching} onClick={() => void query.refetch()}>판정 기준 다시 시도</Button></div>}
    {error && <p role="alert" id={errorId}>{error}</p>}
    {draft && <form id={formId} className="monitoring-policy-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>게이트웨이 오프라인 기준 (초)<input ref={firstInputRef} type="number" min={30} max={900} step={1} value={draft.gateway} disabled={mutation.isPending} aria-describedby={error ? errorId : undefined} onChange={(event) => setDraft({ ...draft, gateway: event.target.value })} /></label>
      <small>30~900초 · 기본 90초</small>
      <label>조명 수신 지연 기준 (초)<input type="number" min={60} max={3600} step={1} value={draft.fixture} disabled={mutation.isPending} aria-describedby={error ? errorId : undefined} onChange={(event) => setDraft({ ...draft, fixture: event.target.value })} /></label>
      <small>60~3600초 · 기본 180초</small>
      {conflict && query.data && <div>
        <p>현재 서버 기준: 게이트웨이 {query.data.gatewayOfflineAfterSeconds}초 · 조명 {query.data.fixtureStaleAfterSeconds}초</p>
        <label className="monitoring-policy-review"><input type="checkbox" checked={reviewed} disabled={!latestAvailable || mutation.isPending} onChange={(event) => setReviewedRevision(event.target.checked ? query.data!.updatedAt : null)} />최신 기준을 확인했습니다</label>
      </div>}
    </form>}
  </ModalDialog>;
}
