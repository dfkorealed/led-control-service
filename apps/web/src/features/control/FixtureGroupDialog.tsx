import type { CreateFixtureGroupInput, FixtureGroupMetadata } from "@led-control/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  createFixtureGroup,
  deleteFixtureGroup,
  fixtureGroupQueryKey,
  listFixtureGroups,
  resyncFixtureGroup,
  updateFixtureGroup
} from "../../api/fixture-groups";
import type { Dashboard, DashboardFixture } from "../../api/queries";
import { useModalFocus } from "./useModalFocus";

interface FixtureGroupDialogProps {
  open: boolean;
  siteId: string;
  dashboard: Dashboard;
  canManage: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}

type GroupForm = {
  groupId: string | null;
  name: string;
  floorId: string;
  gatewayId: string;
  fixtureIds: string[];
};

const emptyForm: GroupForm = { groupId: null, name: "", floorId: "", gatewayId: "", fixtureIds: [] };

export function FixtureGroupDialog({ open, siteId, dashboard, canManage, returnFocusRef, onClose }: FixtureGroupDialogProps) {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLElement>(null);
  const [form, setForm] = useState<GroupForm | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<FixtureGroupMetadata | null>(null);
  const [membershipOverrides, setMembershipOverrides] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState("");
  const groupsQuery = useQuery({
    queryKey: fixtureGroupQueryKey(siteId),
    queryFn: () => listFixtureGroups(siteId),
    enabled: open,
    refetchInterval: open ? 3000 : false
  });
  const groups = groupsQuery.data ?? [];

  useEffect(() => {
    if (!open) {
      setForm(null);
      setDeleteCandidate(null);
      setMessage("");
    }
  }, [open]);

  const saveMutation = useMutation({
    mutationFn: async (input: { groupId: string | null; payload: CreateFixtureGroupInput }) => input.groupId
      ? updateFixtureGroup(siteId, input.groupId, input.payload)
      : createFixtureGroup(siteId, input.payload),
    onSuccess: (group, variables) => {
      queryClient.setQueryData<FixtureGroupMetadata[]>(fixtureGroupQueryKey(siteId), (current = []) =>
        [...current.filter((item) => item.id !== group.id), group].sort(compareGroups)
      );
      setMembershipOverrides((current) => ({ ...current, [group.id]: variables.payload.fixtureIds }));
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setForm(null);
      setMessage(group.meshControlGroup?.status === "configuring"
        ? "구역을 저장했습니다. Mesh 설정이 끝나면 제어할 수 있습니다."
        : "구역을 저장했습니다.");
    }
  });
  const deleteMutation = useMutation({
    mutationFn: (group: FixtureGroupMetadata) => deleteFixtureGroup(siteId, group.id),
    onSuccess: (result) => {
      queryClient.setQueryData<FixtureGroupMetadata[]>(fixtureGroupQueryKey(siteId), (current = []) => current.map((group) =>
        group.id === result.id
          ? { ...group, lifecycleStatus: "retiring", meshControlGroup: result.meshControlGroup }
          : group
      ));
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setDeleteCandidate(null);
      setMessage("구역 삭제를 시작했습니다. Mesh 구독 해제가 끝날 때까지 기다려 주세요.");
    }
  });
  const resyncMutation = useMutation({
    mutationFn: (group: FixtureGroupMetadata) => resyncFixtureGroup(siteId, group.id),
    onSuccess: (group) => {
      queryClient.setQueryData<FixtureGroupMetadata[]>(fixtureGroupQueryKey(siteId), (current = []) => current.map((item) =>
        item.id === group.id ? group : item
      ));
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setMessage("Mesh 재동기화를 시작했습니다.");
    }
  });
  const isMutating = saveMutation.isPending || deleteMutation.isPending || resyncMutation.isPending;

  function closeDialog() {
    if (isMutating) return;
    onClose();
  }

  useModalFocus({ open, dialogRef, returnFocusRef, onClose: closeDialog });

  const dashboardMemberships = useMemo(() => new Map(
    dashboard.groups.map((group) => [group.id, group.fixtureIds])
  ), [dashboard.groups]);

  if (!open) return null;

  function membershipFor(groupId: string) {
    return membershipOverrides[groupId] ?? dashboardMemberships.get(groupId) ?? [];
  }

  function beginEdit(group: FixtureGroupMetadata) {
    setMessage("");
    setDeleteCandidate(null);
    setForm({
      groupId: group.id,
      name: group.name,
      floorId: group.floorId ?? "",
      gatewayId: group.gatewayId ?? "",
      fixtureIds: membershipFor(group.id)
    });
  }

  const error = saveMutation.error ?? deleteMutation.error ?? resyncMutation.error;

  return (
    <div className="fixture-group-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) closeDialog();
    }}>
      <section
        ref={dialogRef}
        className="fixture-group-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fixture-group-dialog-title"
        tabIndex={-1}
      >
        <header className="fixture-group-dialog-header">
          <div>
            <span className="eyebrow">저장 구역</span>
            <h3 id="fixture-group-dialog-title">{form ? (form.groupId ? "구역 수정" : "구역 생성") : "구역 관리"}</h3>
          </div>
          <button className="icon-button" type="button" aria-label="구역 관리 닫기" onClick={closeDialog} disabled={isMutating}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {form ? (
          <FixtureGroupForm
            form={form}
            dashboard={dashboard}
            isSaving={saveMutation.isPending}
            onChange={setForm}
            onCancel={() => setForm(null)}
            onSubmit={(payload) => saveMutation.mutate({ groupId: form.groupId, payload })}
          />
        ) : (
          <>
            <div className="fixture-group-dialog-toolbar">
              <p>{canManage ? "자주 함께 제어할 조명을 구역으로 저장합니다." : "저장 구역과 Mesh 준비 상태를 조회할 수 있습니다."}</p>
              {canManage ? (
                <button className="secondary-button" type="button" onClick={() => {
                  setMessage("");
                  setForm(emptyForm);
                }}>
                  <Plus size={16} aria-hidden="true" /> 새 구역
                </button>
              ) : null}
            </div>

            {groupsQuery.isLoading ? <p className="muted-text" role="status">구역을 불러오는 중입니다.</p> : null}
            {groupsQuery.error ? (
              <div className="fixture-group-dialog-error" role="alert">
                <p className="danger-text">구역 목록을 불러오지 못했습니다.</p>
                <button type="button" onClick={() => void groupsQuery.refetch()}>다시 시도</button>
              </div>
            ) : null}
            {!groupsQuery.isLoading && !groupsQuery.error ? (
              <div className="fixture-group-list" aria-label="저장 구역 목록">
                {groups.map((group) => {
                  const status = fixtureGroupStatus(group);
                  const floorName = dashboard.floors.find((floor) => floor.id === group.floorId)?.name ?? "층 미지정";
                  const gatewayName = dashboard.gateways.find((gateway) => gateway.id === group.gatewayId)?.name ?? "게이트웨이 미지정";
                  const editable = canManage && group.lifecycleStatus === "active";
                  return (
                    <article className="fixture-group-row" key={group.id}>
                      <div className="fixture-group-row-main">
                        <div>
                          <strong>{group.name}</strong>
                          <span>{floorName} · {gatewayName} · {group.fixtureCount}개</span>
                        </div>
                        <span className={`mesh-status-badge ${status.tone}`}>{status.label}</span>
                      </div>
                      {group.meshControlGroup?.error ? <p className="danger-text">{group.meshControlGroup.error}</p> : null}
                      {editable ? (
                        <div className="fixture-group-row-actions">
                          <button type="button" aria-label={`${group.name} 수정`} onClick={() => beginEdit(group)} disabled={isMutating}>
                            <Pencil size={15} aria-hidden="true" /> 수정
                          </button>
                          {group.meshControlGroup?.status === "failed" ? (
                            <button type="button" aria-label={`${group.name} 재동기화`} onClick={() => resyncMutation.mutate(group)} disabled={isMutating}>
                              <RefreshCw size={15} aria-hidden="true" /> 재동기화
                            </button>
                          ) : null}
                          <button className="danger-action" type="button" aria-label={`${group.name} 삭제`} onClick={() => setDeleteCandidate(group)} disabled={isMutating}>
                            <Trash2 size={15} aria-hidden="true" /> 삭제
                          </button>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
                {groups.length === 0 ? <p className="control-empty-state">저장된 구역이 없습니다.</p> : null}
              </div>
            ) : null}
          </>
        )}

        {deleteCandidate ? (
          <div className="fixture-group-delete-confirm" role="alert" aria-label="구역 삭제 확인">
            <p><strong>{deleteCandidate.name}</strong> 구역을 삭제하시겠습니까?</p>
            <div>
              <button type="button" onClick={() => setDeleteCandidate(null)} disabled={deleteMutation.isPending}>취소</button>
              <button className="danger-action" type="button" onClick={() => deleteMutation.mutate(deleteCandidate)} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? "삭제 요청 중" : "삭제 확인"}
              </button>
            </div>
          </div>
        ) : null}
        {message ? <p className="success-text" role="status">{message}</p> : null}
        {error ? <p className="danger-text" role="alert">구역 변경을 완료하지 못했습니다. 입력과 연결 상태를 확인해 주세요.</p> : null}
      </section>
    </div>
  );
}

function FixtureGroupForm({
  form,
  dashboard,
  isSaving,
  onChange,
  onCancel,
  onSubmit
}: {
  form: GroupForm;
  dashboard: Dashboard;
  isSaving: boolean;
  onChange: (form: GroupForm) => void;
  onCancel: () => void;
  onSubmit: (payload: CreateFixtureGroupInput) => void;
}) {
  const gateways = useMemo(() => {
    const gatewayIds = new Set(dashboard.floors.find((floor) => floor.id === form.floorId)?.fixtures
      .flatMap((fixture) => fixture.gateway?.id ? [fixture.gateway.id] : []) ?? []);
    return dashboard.gateways.filter((gateway) => gatewayIds.has(gateway.id));
  }, [dashboard.floors, dashboard.gateways, form.floorId]);
  const fixtures = useMemo(() => dashboard.floors.find((floor) => floor.id === form.floorId)?.fixtures
    .filter((fixture) => fixture.gateway?.id === form.gatewayId) ?? [], [dashboard.floors, form.floorId, form.gatewayId]);
  const selectedFixtureIds = new Set(form.fixtureIds);
  const valid = form.name.trim().length > 0
    && Boolean(form.floorId)
    && Boolean(form.gatewayId)
    && form.fixtureIds.length > 0
    && form.fixtureIds.length <= 100;

  function toggleFixture(fixture: DashboardFixture) {
    if (!fixture.controllable && !selectedFixtureIds.has(fixture.id)) return;
    const fixtureIds = selectedFixtureIds.has(fixture.id)
      ? form.fixtureIds.filter((id) => id !== fixture.id)
      : [...form.fixtureIds, fixture.id].slice(0, 100);
    onChange({ ...form, fixtureIds });
  }

  return (
    <form className="fixture-group-form" onSubmit={(event) => {
      event.preventDefault();
      if (!valid) return;
      onSubmit({
        name: form.name.trim(),
        floorId: form.floorId,
        gatewayId: form.gatewayId,
        fixtureIds: [...form.fixtureIds].sort()
      });
    }}>
      <button className="fixture-group-back" type="button" onClick={onCancel} disabled={isSaving}>
        <ArrowLeft size={16} aria-hidden="true" /> 목록으로
      </button>
      <label className="form-field">
        <span>구역 이름</span>
        <input value={form.name} maxLength={200} onChange={(event) => onChange({ ...form, name: event.target.value })} />
      </label>
      <div className="fixture-group-boundary-fields">
        <label className="form-field">
          <span>층</span>
          <select aria-label="층" value={form.floorId} onChange={(event) => onChange({ ...form, floorId: event.target.value, gatewayId: "", fixtureIds: [] })}>
            <option value="">층 선택</option>
            {dashboard.floors.map((floor) => <option key={floor.id} value={floor.id}>{floor.name}</option>)}
          </select>
        </label>
        <label className="form-field">
          <span>게이트웨이</span>
          <select aria-label="게이트웨이" value={form.gatewayId} disabled={!form.floorId} onChange={(event) => onChange({ ...form, gatewayId: event.target.value, fixtureIds: [] })}>
            <option value="">게이트웨이 선택</option>
            {gateways.map((gateway) => <option key={gateway.id} value={gateway.id}>{gateway.name}</option>)}
          </select>
        </label>
      </div>
      <div className="fixture-group-member-heading">
        <strong>조명 선택</strong>
        <span>{form.fixtureIds.length} / 100개</span>
      </div>
      <div className="fixture-group-member-list" role="group" aria-label="구역 조명 목록">
        {fixtures.map((fixture) => {
          const checked = selectedFixtureIds.has(fixture.id);
          return (
            <label key={fixture.id} className={checked ? "selected" : ""}>
              <input
                type="checkbox"
                aria-label={`${fixture.name} 포함`}
                checked={checked}
                disabled={!fixture.controllable && !checked}
                onChange={() => toggleFixture(fixture)}
              />
              <span><strong>{fixture.name}</strong><small>{fixture.controllable ? "제어 가능" : "제어 불가"}</small></span>
              <span>{fixture.brightness}%</span>
            </label>
          );
        })}
        {form.gatewayId && fixtures.length === 0 ? <p className="control-empty-state">선택 가능한 조명이 없습니다.</p> : null}
        {!form.gatewayId ? <p className="control-empty-state">층과 게이트웨이를 먼저 선택하세요.</p> : null}
      </div>
      <div className="fixture-group-form-actions">
        <button type="button" onClick={onCancel} disabled={isSaving}>취소</button>
        <button className="primary-button" type="submit" disabled={!valid || isSaving}>
          {isSaving ? "저장 중" : form.groupId ? "변경 저장" : "구역 만들기"}
        </button>
      </div>
    </form>
  );
}

function fixtureGroupStatus(group: FixtureGroupMetadata) {
  if (group.lifecycleStatus === "retiring") return { label: "삭제 중", tone: "pending" };
  if (group.lifecycleStatus === "retired") return { label: "삭제 완료", tone: "muted" };
  if (group.lifecycleStatus === "invalid") return { label: "읽기 전용", tone: "muted" };
  if (group.meshControlGroup?.status === "ready") return { label: "제어 준비 완료", tone: "ready" };
  if (group.meshControlGroup?.status === "failed") return { label: "Mesh 설정 실패", tone: "failed" };
  if (group.meshControlGroup?.status === "retiring") return { label: "삭제 중", tone: "pending" };
  return { label: "Mesh 설정 중", tone: "pending" };
}

function compareGroups(left: FixtureGroupMetadata, right: FixtureGroupMetadata) {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}
