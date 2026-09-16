import type { CreateFixtureGroupInput, FixtureGroupMetadata } from "@led-control/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleCheck, Clock3, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
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
import { Button, Card, Checkbox, ConfirmDialog, Heading, ModalDialog, SelectBox, StatusBadge, Text, TextField } from "../../components/ui";
import { humanizeDeviceResponseMessage } from "./control-copy";

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
  const deleteButtonRef = useRef<HTMLElement | null>(null);
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

  const dashboardMemberships = useMemo(() => new Map(
    dashboard.groups.map((group) => [group.id, group.fixtureIds])
  ), [dashboard.groups]);

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
    <ModalDialog
      isOpen={open}
      title={form ? (form.groupId ? "구역 수정" : "구역 생성") : "구역 관리"}
      description="저장 구역"
      closeLabel="구역 관리 닫기"
      isPending={isMutating}
      returnFocusRef={returnFocusRef}
      onClose={closeDialog}
      className="grid max-w-3xl gap-4"
    >

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
              <div className="flex items-center justify-between gap-3 max-compact:flex-col max-compact:items-stretch">
                <Text>{canManage ? "자주 함께 제어할 조명을 구역으로 저장합니다." : "저장 구역과 Mesh 준비 상태를 조회할 수 있습니다."}</Text>
              {canManage ? (
                <Button variant="secondary" type="button" onClick={() => {
                  setMessage("");
                  setForm(emptyForm);
                }}>
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
                          <Button variant="secondary" type="button" aria-label={`${group.name} 수정`} onClick={() => beginEdit(group)} disabled={isMutating}>
                            <Pencil size={15} aria-hidden="true" /> 수정
                          </Button>
                          {group.meshControlGroup?.status === "failed" ? (
                            <Button variant="secondary" type="button" aria-label={`${group.name} 재동기화`} onClick={() => resyncMutation.mutate(group)} disabled={isMutating}>
                              <RefreshCw size={15} aria-hidden="true" /> 재동기화
                            </Button>
                          ) : null}
                          <Button variant="danger" type="button" aria-label={`${group.name} 삭제`} onClick={(event) => { deleteButtonRef.current = event.currentTarget; setDeleteCandidate(group); }} disabled={isMutating}>
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
          isPending={deleteMutation.isPending}
          tone="danger"
          returnFocusRef={deleteButtonRef}
          onCancel={() => {
            if (!deleteMutation.isPending) setDeleteCandidate(null);
          }}
          onConfirm={() => deleteCandidate && deleteMutation.mutate(deleteCandidate)}
        />
        {message ? <Text tone="success" role="status">{message}</Text> : null}
        {error ? <Text tone="danger" role="alert">구역 변경을 완료하지 못했습니다. 입력과 연결 상태를 확인해 주세요.</Text> : null}
    </ModalDialog>
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

  const floorItems = [{ id: "", label: "층 선택" }, ...dashboard.floors.map((floor) => ({ id: floor.id, label: floor.name }))];
  const gatewayItems = [{ id: "", label: "게이트웨이 선택" }, ...gateways.map((gateway) => ({ id: gateway.id, label: gateway.name }))];

  return (
    <Card className="grid gap-2.5 p-4" data-fixture-group-editor-card="">
    <form className="grid gap-4" onSubmit={(event) => {
      event.preventDefault();
      if (!valid) return;
      onSubmit({
        name: form.name.trim(),
        floorId: form.floorId,
        gatewayId: form.gatewayId,
        fixtureIds: [...form.fixtureIds].sort()
      });
    }}>
      <Button variant="ghost" className="justify-self-start" type="button" onClick={onCancel} disabled={isSaving}>
        <ArrowLeft size={16} aria-hidden="true" /> 목록으로
      </Button>
      <div className="grid gap-1">
        <Text as="span" variant="overline" tone="muted">선택 구역</Text>
        <Heading as="h4" variant="card-title">구역 편집</Heading>
      </div>
      <TextField label="구역 이름" value={form.name} maxLength={200} onChange={(value) => onChange({ ...form, name: value })} />
      <div className="grid grid-cols-2 gap-3 max-compact:grid-cols-1">
        <SelectBox label="층" items={floorItems} selectedKey={form.floorId} onSelectionChange={(key) => onChange({ ...form, floorId: key ?? "", gatewayId: "", fixtureIds: [] })} />
        <SelectBox label="게이트웨이" items={gatewayItems} selectedKey={form.gatewayId} isDisabled={!form.floorId} onSelectionChange={(key) => onChange({ ...form, gatewayId: key ?? "", fixtureIds: [] })} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Text as="strong" weight="semibold">조명 선택</Text>
        <Text as="span" variant="caption">{form.fixtureIds.length} / 100개</Text>
      </div>
      <div className="grid max-h-80 overflow-y-auto rounded-panel border border-border-default" role="group" aria-label="구역 조명 목록">
        {fixtures.map((fixture) => {
          const checked = selectedFixtureIds.has(fixture.id);
          return (
            <div key={fixture.id} className={`grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border-subtle pb-2 last:border-b-0 ${checked ? "bg-action-primary-soft" : ""}`}>
              <Checkbox
                className="min-w-0 [&>label]:w-full [&>label]:min-w-0 [&>label]:justify-start [&>label]:rounded-none [&>label]:border-0 [&>label]:bg-transparent [&>label]:px-3 [&>label]:py-2 [&>label[data-selected]]:bg-transparent"
                label={(
                  <span className="flex min-w-0 items-center">
                    <Text as="strong" weight="semibold">{fixture.name}</Text>
                    <span className="sr-only"> 포함</span>
                  </span>
                )}
                isSelected={checked}
                isDisabled={!fixture.controllable && !checked}
                onChange={() => toggleFixture(fixture)}
              />
              <Text as="small" variant="caption" tone="secondary" className="min-w-0 pl-12">{fixture.controllable ? "제어 가능" : "제어 불가"}</Text>
              <Text as="span" weight="semibold" className="col-start-2 row-span-2 row-start-1 pr-3">{fixture.brightness}%</Text>
            </div>
          );
        })}
        {form.gatewayId && fixtures.length === 0 ? <Text className="p-4 text-center" tone="secondary">선택 가능한 조명이 없습니다.</Text> : null}
        {!form.gatewayId ? <Text className="p-4 text-center" tone="secondary">층과 게이트웨이를 먼저 선택하세요.</Text> : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" type="button" onClick={onCancel} disabled={isSaving}>취소</Button>
        <Button variant="primary" type="submit" disabled={!valid} isLoading={isSaving} loadingLabel="저장 중">
          {form.groupId ? "변경 저장" : "구역 만들기"}
        </Button>
      </div>
    </form>
    </Card>
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
