import type { CreateFixtureGroupInput, FixtureGroupMetadata } from "@led-control/shared";
import { ArrowLeft, CircleCheck, Clock3, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Dashboard } from "../../../api/queries";
import { Button, ConfirmDialog, Heading, StatusBadge, Text, TextField } from "../../../components/ui";
import { humanizeDeviceResponseMessage } from "../control-copy";
import { FixtureGroupMapEditor, fixtureGroupMembershipError, type FixtureGroupEditorValue } from "../target-selection/FixtureGroupMapEditor";
import type { useFixtureGroupsWorkspace } from "./useFixtureGroupsWorkspace";
type GroupForm = FixtureGroupEditorValue;

export function FixtureGroupsContent({ siteId, dashboard, workspace }: {
  siteId: string; dashboard: Dashboard; workspace: ReturnType<typeof useFixtureGroupsWorkspace>;
}) {
  const { form, groups, groupsQuery, canManage, mutationDisabled, isSaving, isDeleting,
    deleteCandidate, deleteButtonRef, message, error, beginCreate, beginEdit, changeForm,
    save, requestDelete, confirmDelete, resync, cancelForm, cancelDelete } = workspace;
  return <>        {form ? (
          <FixtureGroupForm
            form={form}
            siteId={siteId}
            dashboard={dashboard}
            isSaving={isSaving}
            isDisabled={mutationDisabled}
            onChange={changeForm}
            onCancel={cancelForm}
            onSubmit={save}
          />
        ) : (
          <>
              <div className="flex items-center justify-between gap-3 max-compact:flex-col max-compact:items-stretch">
                <Text>{canManage ? "자주 함께 제어할 조명을 구역으로 저장합니다." : "저장 구역과 Mesh 준비 상태를 조회할 수 있습니다."}</Text>
              {canManage ? (
                <Button variant="secondary" type="button" onClick={beginCreate} disabled={mutationDisabled}>
                  <Plus size={16} aria-hidden="true" /> 새 구역
                </Button>
              ) : null}
            </div>

            {groupsQuery.isLoading ? <Text tone="muted" role="status">구역을 불러오는 중입니다.</Text> : null}
            {groupsQuery.error ? (
              <div className="grid gap-2" role="alert">
                <Text tone="danger">구역 목록을 불러오지 못했습니다.</Text>
                <Button variant="secondary" type="button" onClick={() => void groupsQuery.refetch()}>다시 시도</Button>
              </div>
            ) : null}
            {!groupsQuery.isLoading && !groupsQuery.error ? (
              <section className="grid gap-3" aria-labelledby="fixture-group-list-heading">
                <div className="flex items-end justify-between gap-3">
                  <div className="grid gap-1">
                    <Text as="span" variant="overline" tone="muted">현재 구성</Text>
                    <Heading as="h4" id="fixture-group-list-heading" variant="card-title">현재 저장 구역</Heading>
                  </div>
                  <span>{groups.length}개</span>
                </div>
              <div className="grid gap-2" aria-label="저장 구역 목록">
                {groups.map((group) => {
                  const status = fixtureGroupStatus(group);
                  const floorName = dashboard.floors.find((floor) => floor.id === group.floorId)?.name ?? "층 미지정";
                  const gatewayName = dashboard.gateways.find((gateway) => gateway.id === group.gatewayId)?.name ?? "게이트웨이 미지정";
                  const editable = canManage && group.lifecycleStatus === "active";
                  return (
                    <article className="grid gap-3 rounded-panel border border-border-default bg-surface-panel p-3" key={group.id}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="grid gap-1">
                          <Text as="strong" weight="semibold">{group.name}</Text>
                          <Text as="span" variant="caption">{floorName} · {gatewayName} · {group.fixtureCount}개</Text>
                          <Text as="small" variant="caption" tone="secondary">{group.meshControlGroup ? `Mesh 구성 v${group.meshControlGroup.version} · 주소 정보 없음` : "Mesh 주소 정보 없음"}</Text>
                        </div>
                        <StatusBadge tone={group.meshControlGroup?.status === "ready" ? "success" : "warning"} icon={group.meshControlGroup?.status === "ready" ? CircleCheck : Clock3}>
                          {group.meshControlGroup?.status === "ready" ? "준비됨" : "확인 필요"}
                        </StatusBadge>
                      </div>
                      <Text variant="caption" tone={status.tone === "failed" ? "danger" : "secondary"}>{status.label}</Text>
                      {group.meshControlGroup?.error ? <Text tone="danger">{humanizeDeviceResponseMessage(group.meshControlGroup.error)}</Text> : null}
                      {editable ? (
                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary" type="button" aria-label={`${group.name} 수정`} onClick={() => beginEdit(group)} disabled={mutationDisabled}>
                            <Pencil size={15} aria-hidden="true" /> 수정
                          </Button>
                          {group.meshControlGroup?.status === "failed" ? (
                            <Button variant="secondary" type="button" aria-label={`${group.name} 재동기화`} onClick={() => resync(group)} disabled={mutationDisabled}>
                              <RefreshCw size={15} aria-hidden="true" /> 재동기화
                            </Button>
                          ) : null}
                          <Button variant="danger" type="button" aria-label={`${group.name} 삭제`} onClick={(event) => requestDelete(group, event.currentTarget)} disabled={mutationDisabled}>
                            <Trash2 size={15} aria-hidden="true" /> 삭제
                          </Button>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
                {groups.length === 0 ? <Text className="p-4 text-center" tone="secondary">저장된 구역이 없습니다.</Text> : null}
              </div>
              </section>
            ) : null}
          </>
        )}

        <ConfirmDialog
          isOpen={Boolean(deleteCandidate)}
          title="구역 삭제 확인"
          description={deleteCandidate ? <><strong>{deleteCandidate.name}</strong> 구역을 삭제하시겠습니까?</> : undefined}
          confirmLabel="삭제 확인"
          isPending={isDeleting}
          confirmDisabled={mutationDisabled}
          tone="danger"
          returnFocusRef={deleteButtonRef}
          onCancel={cancelDelete}
          onConfirm={confirmDelete}
        />
        {message ? <Text tone="success" role="status">{message}</Text> : null}
        {error ? <Text tone="danger" role="alert">구역 변경을 완료하지 못했습니다. 입력과 연결 상태를 확인해 주세요.</Text> : null}
</>;
}

function FixtureGroupForm({
  form,
  siteId,
  dashboard,
  isSaving,
  isDisabled,
  onChange,
  onCancel,
  onSubmit
}: {
  form: GroupForm;
  siteId: string;
  dashboard: Dashboard;
  isSaving: boolean;
  isDisabled: boolean;
  onChange: (form: GroupForm) => void;
  onCancel: () => void;
  onSubmit: (payload: CreateFixtureGroupInput) => void;
}) {
  const [validationError, setValidationError] = useState<string | null>(null);

  return (
    <form className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain" onSubmit={(event) => {
      event.preventDefault();
      if (isDisabled) return;
      const membershipError = fixtureGroupMembershipError(form.fixtureIds);
      const error = !form.name.trim()
        ? "구역 이름을 입력하세요."
        : !form.floorId || !form.gatewayId
          ? "층과 게이트웨이 경계를 선택하세요."
          : membershipError;
      if (error) {
        setValidationError(error);
        return;
      }
      setValidationError(null);
      onSubmit({
        name: form.name.trim(),
        floorId: form.floorId,
        gatewayId: form.gatewayId,
        fixtureIds: [...form.fixtureIds].sort()
      });
    }}>
      <div className="flex shrink-0 items-end gap-3 max-compact:flex-col max-compact:items-stretch">
      <Button variant="ghost" type="button" onClick={onCancel} disabled={isSaving}>
        <ArrowLeft size={16} aria-hidden="true" /> 목록으로
      </Button>
      <TextField className="flex-1" size="lg" label="구역 이름" value={form.name} maxLength={200} isDisabled={isDisabled} onChange={(value) => {
        setValidationError(null);
        onChange({ ...form, name: value });
      }} />
      </div>
      <FixtureGroupMapEditor siteId={siteId} dashboard={dashboard} value={form} disabled={isDisabled} onChange={(next) => {
        setValidationError(null);
        onChange(next);
      }} />
      <Text variant="caption" tone="secondary">저장 후 Mesh 설정 중</Text>
      {validationError ? <Text role="alert" tone="danger">{validationError}</Text> : null}
      <div className="flex shrink-0 justify-end gap-2">
        <Button variant="secondary" type="button" onClick={onCancel} disabled={isSaving}>취소</Button>
        <Button variant="primary" type="submit" disabled={isDisabled} isLoading={isSaving} loadingLabel="저장 중">
          {form.groupId ? "변경 저장" : "구역 만들기"}
        </Button>
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
