import type { CreateFixtureGroupInput, FixtureGroupMetadata } from "@led-control/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createFixtureGroup, deleteFixtureGroup, fixtureGroupQueryKey, listFixtureGroups, resyncFixtureGroup, updateFixtureGroup } from "../../../api/fixture-groups";
import type { Dashboard } from "../../../api/queries";
import { fixtureGroupMembershipError, type FixtureGroupEditorValue } from "../target-selection/FixtureGroupMapEditor";

interface WorkspaceOptions {
  siteId: string;
  dashboard: Dashboard;
  canManage: boolean;
  isActive: boolean;
  mutationsBlocked: boolean;
}
type OperationScope = { siteId: string; generation: number };
const emptyForm: FixtureGroupEditorValue = { groupId: null, name: "", floorId: "", gatewayId: "", fixtureIds: [] };

export function useFixtureGroupsWorkspace({ siteId, dashboard, canManage, isActive, mutationsBlocked }: WorkspaceOptions) {
  const queryClient = useQueryClient();
  const deleteButtonRef = useRef<HTMLElement | null>(null);
  const [form, setForm] = useState<FixtureGroupEditorValue | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<FixtureGroupMetadata | null>(null);
  const [membershipOverrides, setMembershipOverrides] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState("");
  const scope = useRef({ siteId, isActive, generation: 0 });
  const mounted = useRef(true);
  if (scope.current.siteId !== siteId || scope.current.isActive !== isActive) {
    scope.current = { siteId, isActive, generation: scope.current.generation + 1 };
  }
  const access = useRef({ canManage, isActive, mutationsBlocked, pending: false });
  access.current = { ...access.current, canManage, isActive, mutationsBlocked };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    setForm(null); setDeleteCandidate(null); setMessage("");
  }, [siteId, isActive]);
  useEffect(() => { setMembershipOverrides({}); }, [siteId]);
  const groupsQuery = useQuery({
    queryKey: fixtureGroupQueryKey(siteId), queryFn: () => listFixtureGroups(siteId),
    enabled: isActive, refetchInterval: isActive ? 3000 : false
  });
  function isCurrent(operation: OperationScope) {
    return mounted.current && scope.current.isActive && scope.current.siteId === operation.siteId
      && scope.current.generation === operation.generation;
  }
  // A completion still belongs to its original site cache, never to a new
  // site's form/message. This is local presentation lifetime, not command ownership.
  const saveMutation = useMutation({
    mutationFn: (input: OperationScope & { groupId: string | null; payload: CreateFixtureGroupInput }) =>
      input.groupId ? updateFixtureGroup(input.siteId, input.groupId, input.payload) : createFixtureGroup(input.siteId, input.payload),
    onSuccess: (group, variables) => {
      queryClient.setQueryData<FixtureGroupMetadata[]>(fixtureGroupQueryKey(variables.siteId), (current = []) =>
        [...current.filter((item) => item.id !== group.id), group].sort(compareGroups));
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      if (!isCurrent(variables)) return;
      setMembershipOverrides((current) => ({ ...current, [group.id]: variables.payload.fixtureIds }));
      setForm(null);
      setMessage(group.meshControlGroup?.status === "configuring"
        ? "구역을 저장했습니다. Mesh 설정이 끝나면 제어할 수 있습니다." : "구역을 저장했습니다.");
    },
    onSettled: () => { access.current.pending = false; }
  });
  const deleteMutation = useMutation({
    mutationFn: (input: OperationScope & { group: FixtureGroupMetadata }) => deleteFixtureGroup(input.siteId, input.group.id),
    onSuccess: (result, variables) => {
      queryClient.setQueryData<FixtureGroupMetadata[]>(fixtureGroupQueryKey(variables.siteId), (current = []) =>
        current.map((group) => group.id === result.id ? { ...group, lifecycleStatus: "retiring", meshControlGroup: result.meshControlGroup } : group));
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      if (!isCurrent(variables)) return;
      setDeleteCandidate(null);
      setMessage("구역 삭제를 시작했습니다. Mesh 구독 해제가 끝날 때까지 기다려 주세요.");
    },
    onSettled: () => { access.current.pending = false; }
  });
  const resyncMutation = useMutation({
    mutationFn: (input: OperationScope & { group: FixtureGroupMetadata }) => resyncFixtureGroup(input.siteId, input.group.id),
    onSuccess: (group, variables) => {
      queryClient.setQueryData<FixtureGroupMetadata[]>(fixtureGroupQueryKey(variables.siteId), (current = []) =>
        current.map((item) => item.id === group.id ? group : item));
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      if (isCurrent(variables)) setMessage("Mesh 재동기화를 시작했습니다.");
    },
    onSettled: () => { access.current.pending = false; }
  });
  const isMutating = saveMutation.isPending || deleteMutation.isPending || resyncMutation.isPending;
  function allowed() {
    const latest = access.current;
    return latest.canManage && latest.isActive && !latest.mutationsBlocked && !latest.pending && !isMutating;
  }
  const mutationDisabled = !canManage || !isActive || mutationsBlocked || isMutating;
  const dashboardMemberships = useMemo(() => new Map(dashboard.groups.map((group) => [group.id, group.fixtureIds])), [dashboard.groups]);
  function beginCreate() {
    if (!allowed()) return;
    setMessage(""); setDeleteCandidate(null); setForm(emptyForm);
  }
  function beginEdit(group: FixtureGroupMetadata) {
    if (!allowed() || group.lifecycleStatus !== "active") return;
    setMessage(""); setDeleteCandidate(null);
    setForm({ groupId: group.id, name: group.name, floorId: group.floorId ?? "", gatewayId: group.gatewayId ?? "",
      fixtureIds: membershipOverrides[group.id] ?? dashboardMemberships.get(group.id) ?? [] });
  }
  function changeForm(next: FixtureGroupEditorValue) {
    if (allowed()) setForm(next);
  }
  function save(payload: CreateFixtureGroupInput) {
    if (!allowed() || !form || !payload.name.trim() || !payload.floorId || !payload.gatewayId || fixtureGroupMembershipError(payload.fixtureIds)) return;
    access.current.pending = true;
    saveMutation.mutate({ siteId: scope.current.siteId, generation: scope.current.generation, groupId: form.groupId, payload });
  }
  function requestDelete(group: FixtureGroupMetadata, target: HTMLElement) {
    if (!allowed() || group.lifecycleStatus !== "active") return;
    deleteButtonRef.current = target; setDeleteCandidate(group);
  }
  function confirmDelete() {
    if (!allowed() || !deleteCandidate || deleteCandidate.lifecycleStatus !== "active") return;
    access.current.pending = true;
    deleteMutation.mutate({ siteId: scope.current.siteId, generation: scope.current.generation, group: deleteCandidate });
  }
  function resync(group: FixtureGroupMetadata) {
    if (!allowed() || group.lifecycleStatus !== "active" || group.meshControlGroup?.status !== "failed") return;
    access.current.pending = true;
    resyncMutation.mutate({ siteId: scope.current.siteId, generation: scope.current.generation, group });
  }
  return {
    form, groups: groupsQuery.data ?? [], groupsQuery, canManage, mutationDisabled, isMutating,
    isSaving: saveMutation.isPending, isDeleting: deleteMutation.isPending, deleteCandidate, deleteButtonRef, message,
    error: (saveMutation.variables && isCurrent(saveMutation.variables) ? saveMutation.error : null)
      ?? (deleteMutation.variables && isCurrent(deleteMutation.variables) ? deleteMutation.error : null)
      ?? (resyncMutation.variables && isCurrent(resyncMutation.variables) ? resyncMutation.error : null),
    beginCreate, beginEdit, changeForm, save, requestDelete, confirmDelete, resync,
    cancelForm: () => { if (!isMutating) setForm(null); },
    cancelDelete: () => { if (!deleteMutation.isPending) setDeleteCandidate(null); }
  };
}
function compareGroups(left: FixtureGroupMetadata, right: FixtureGroupMetadata) {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}
