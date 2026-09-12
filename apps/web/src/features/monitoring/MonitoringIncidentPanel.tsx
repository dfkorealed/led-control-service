import { useEffect, useId, useRef, useState } from "react";
import { CircleCheck, Clock3, TriangleAlert } from "lucide-react";
import {
  incidentMutationErrorMessage, incidentStatusLabels, incidentTypeLabels, useMonitoringIncidentMutation, useMonitoringIncidents,
  type IncidentAction, type IncidentFilters, type MonitoringIncident
} from "../../api/monitoring-incidents";
import { useSiteUsers, type SiteUserSummary } from "../../api/site-users";
import { Button, Card, StatusBadge } from "../../components/ui";
import { MonitoringPolicyDialog } from "./MonitoringPolicyDialog";

export function MonitoringIncidentPanel({ siteId, canManage, onActiveCountChange }: {
  siteId: string; canManage: boolean; onActiveCountChange: (count: number) => void;
}) {
  const [filters, setFilters] = useState<IncidentFilters>({ status: "all", type: "all" });
  const [policyOpen, setPolicyOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const query = useMonitoringIncidents(siteId, filters);
  const activeCount = query.data?.pages[0]?.activeCount;
  const incidents = query.data?.pages.flatMap((page) => page.incidents) ?? [];
  // Cursor windows can overlap when polling observes reordered rows. Keep each occurrence once.
  const uniqueIncidents = [...new Map(incidents.map((incident) => [incident.id, incident])).values()];
  useEffect(() => { if (activeCount !== undefined) onActiveCountChange(activeCount); }, [activeCount, onActiveCountChange]);
  return (
    <div className="monitoring-incidents">
      <div className="monitoring-incident-heading">
        <h3>인시던트 이력</h3>
        {canManage && <Button onClick={() => setPolicyOpen(true)}>판정 기준</Button>}
      </div>
      {notice && <p role="status">{notice}</p>}
      <p>활성 인시던트 {activeCount ?? "확인 중"}{activeCount !== undefined ? "건" : ""}</p>
      <div role="group" aria-label="인시던트 필터" className="monitoring-incident-filters">
        <label>인시던트 상태<select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value as IncidentFilters["status"] }))}>
          <option value="all">전체 상태</option>
          {Object.entries(incidentStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>인시던트 유형<select value={filters.type} onChange={(event) => setFilters((current) => ({ ...current, type: event.target.value as IncidentFilters["type"] }))}>
          <option value="all">전체 유형</option>
          {Object.entries(incidentTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
      </div>
      {query.isPending && <p role="status">인시던트를 불러오는 중</p>}
      {query.error && <div role="alert">
        <p>{query.data ? "저장된 인시던트 이력을 유지하고 있습니다. 갱신에 실패했습니다." : "인시던트 이력을 불러오지 못했습니다."}</p>
        <Button disabled={query.isFetching} onClick={() => void query.refetch()}>인시던트 다시 시도</Button>
      </div>}
      {query.data && uniqueIncidents.length === 0 && <p>선택한 조건의 인시던트가 없습니다.</p>}
      {canManage
        ? <ManagedIncidentList siteId={siteId} incidents={uniqueIncidents} />
        : <IncidentList incidents={uniqueIncidents} />}
      {query.hasNextPage && <Button isLoading={query.isFetchingNextPage} loadingLabel="이력 불러오는 중" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>더 보기</Button>}
      {canManage && policyOpen && <MonitoringPolicyDialog siteId={siteId} onClose={() => setPolicyOpen(false)} onSaved={() => setNotice("판정 기준을 저장했습니다.")} />}
    </div>
  );
}

// Mount only for manage capability: read-only users must not even request the protected users API.
function ManagedIncidentList({ siteId, incidents }: { siteId: string; incidents: MonitoringIncident[] }) {
  const usersQuery = useSiteUsers(siteId);
  const mutation = useMonitoringIncidentMutation(siteId);
  const pendingRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Refresh can resolve/remove a row and unmount its form before PATCH finishes. Keep its
  // failure announcement above the list so that the operator still receives the conflict.
  async function perform(incident: MonitoringIncident, action: IncidentAction) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setActionError(null);
    try {
      await mutation.mutateAsync({ incidentId: incident.id, ...action, expectedUpdatedAt: incident.updatedAt });
    } catch (failure) {
      setActionError(incidentMutationErrorMessage(failure));
    } finally { pendingRef.current = false; }
  }
  return <>
    {actionError && <p role="alert">{actionError}</p>}
    <IncidentList incidents={incidents} management={{ users: usersQuery.data?.users.filter((user) => user.status === "active") ?? [], usersError: Boolean(usersQuery.error), usersLoading: usersQuery.isPending, isPending: mutation.isPending, perform }} />
  </>;
}
interface IncidentManagement {
  users: SiteUserSummary[];
  usersError: boolean;
  usersLoading: boolean;
  isPending: boolean;
  perform: (incident: MonitoringIncident, action: IncidentAction) => Promise<void>;
}
function IncidentList({ incidents, management }: { incidents: MonitoringIncident[]; management?: IncidentManagement }) {
  return <div className="monitoring-incident-list" role="list" aria-label="인시던트 이력">
    {incidents.map((incident) => <Card key={incident.id} role="listitem" className="monitoring-incident-card">
      <div className="monitoring-incident-heading">
        <h4>{incident.target.name}</h4>
        <StatusBadge icon={incident.status === "resolved" ? CircleCheck : incident.status === "acknowledged" ? Clock3 : TriangleAlert} tone={incident.status === "resolved" ? "success" : incident.status === "acknowledged" ? "warning" : "danger"}>{incidentStatusLabels[incident.status]}</StatusBadge>
      </div>
      <p>{incidentTypeLabels[incident.type]}</p>
      <dl className="monitoring-incident-history">
        <div><dt>발생</dt><dd><IncidentTime value={incident.openedAt} /></dd></div>
        <div><dt>최근 관측</dt><dd><IncidentTime value={incident.lastObservedAt} /></dd></div>
        <div><dt>담당</dt><dd>{incident.assignedTo ? `${incident.assignedTo.name} (${incident.assignedTo.loginId})` : "미지정"}</dd></div>
        {incident.acknowledgedAt && <div><dt>확인</dt><dd>{incident.acknowledgedBy?.name ?? "사용자 정보 없음"} · <IncidentTime value={incident.acknowledgedAt} /></dd></div>}
        {incident.resolvedAt && <div><dt>해결</dt><dd><IncidentTime value={incident.resolvedAt} /> · {incident.resolvedBy?.name ?? (incident.resolutionKind === "automatic_recovery" ? "시스템" : "사용자 정보 없음")}</dd></div>}
        {incident.resolutionKind && <div><dt>해결 방식</dt><dd>{incident.resolutionKind === "automatic_recovery" ? "자동 복구" : "운영자 복구 확인"}</dd></div>}
        {incident.resolutionNote && <div><dt>해결 메모</dt><dd>{incident.resolutionNote}</dd></div>}
      </dl>
      {management && incident.status !== "resolved" && <IncidentActions incident={incident} {...management} />}
    </Card>)}
  </div>;
}
function IncidentTime({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString("ko-KR")}</time>;
}
function IncidentActions({ incident, users, usersError, usersLoading, isPending, perform }: IncidentManagement & { incident: MonitoringIncident }) {
  const [assignee, setAssignee] = useState(incident.assignedTo?.id ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const assignedId = incident.assignedTo?.id ?? "";
  useEffect(() => { setAssignee(assignedId); }, [assignedId]);
  function submit(action: IncidentAction) {
    if (isPending) return;
    if (action.action === "resolve" && (!action.note.trim() || action.note.trim().length > 2000)) {
      setError("해결 메모는 공백을 제외해 1~2000자로 입력하세요.");
      return;
    }
    setError(null);
    void perform(incident, action);
  }
  return <div role="group" aria-label="인시던트 조치" className="monitoring-incident-actions">
    {error && <p role="alert" id={errorId}>{error}</p>}
    {incident.status === "open" && <Button disabled={isPending} onClick={() => submit({ action: "acknowledge" })}>확인</Button>}
    {usersError && <p role="status">담당자 목록을 불러오지 못했습니다. 기존 담당자를 유지합니다.</p>}
    <label>담당자<select value={assignee} disabled={isPending || usersLoading || usersError} onChange={(event) => setAssignee(event.target.value)}>
      <option value="">미지정</option>
      {incident.assignedTo && !users.some((user) => user.id === incident.assignedTo?.id) && <option value={incident.assignedTo.id}>{incident.assignedTo.name} (현재 담당)</option>}
      {users.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.loginId})</option>)}
    </select></label>
    <Button disabled={isPending || usersLoading || usersError} onClick={() => submit({ action: "assign", userId: assignee || null })}>담당 저장</Button>
    <label>해결 메모<textarea value={note} disabled={isPending} aria-describedby={error ? errorId : undefined} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={2000} /></label>
    <Button disabled={isPending} onClick={() => submit({ action: "resolve", note: note.trim() })}>해결</Button>
  </div>;
}
