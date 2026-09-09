import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Clock3, Radar } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Dashboard } from "../../api/queries";
import {
  cancelRegistrationSession,
  completeRegistrationSession,
  createRegistrationSession,
  excludeRegistrationNode,
  getActiveRegistrationSessions,
  getRegistrationSession,
  registerFixtureBatch,
  retryRegistrationScan,
  type DiscoveredRegistrationNode,
  type RegisterFixtureBatchInput,
  type RegistrationSession
} from "../../api/registration";
import { Button, Card, FeedbackState, ProgressSteps, StatusBadge, type ProgressStep, type ProgressStepState } from "../../components/ui";
import { humanizeTransportMessage } from "../transport-copy";
import { FixtureBatchForm, type FixtureBatchDefaults } from "./FixtureBatchForm";
import {
  FixtureIndividualForm,
  type FixtureIndividualDefaults,
  type FixtureIndividualDraft
} from "./FixtureIndividualForm";

interface RegistrationPanelProps {
  dashboard: Dashboard | undefined;
  dashboardQuerySiteId?: string;
}

const statusLabels = {
  discovered: "발견",
  identifying: "등록 대기",
  provisioning: "등록 중",
  provisioned: "등록 완료",
  failed: "실패",
  reconcile_required: "확인 필요"
} as const;

const statusProgress = {
  discovered: 0,
  identifying: 1,
  provisioning: 2,
  provisioned: 3,
  failed: 3,
  reconcile_required: 3
} as const;

type RegistrationMode = "batch" | "individual";

const initialBatchDefaults: FixtureBatchDefaults = {
  namePrefix: "B2-L",
  startNumber: 1,
  digits: 3,
  ratedWatt: "40.00",
  size: 20
};

const initialIndividualDefaults: FixtureIndividualDefaults = {
  namePrefix: "B2-L",
  startNumber: 1,
  digits: 3
};

export function RegistrationPanel({ dashboard, dashboardQuerySiteId }: RegistrationPanelProps) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<RegistrationSession | null>(null);
  const [localNodes, setLocalNodes] = useState<DiscoveredRegistrationNode[]>([]);
  const [selectedFloorId, setSelectedFloorId] = useState("");
  const [selectedGatewayId, setSelectedGatewayId] = useState("");
  const [mode, setMode] = useState<RegistrationMode>("batch");
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [submittedNodeIds, setSubmittedNodeIds] = useState<string[]>([]);
  const [batchDefaults, setBatchDefaults] = useState(initialBatchDefaults);
  const [individualDefaults, setIndividualDefaults] = useState(initialIndividualDefaults);
  const [individualDrafts, setIndividualDrafts] = useState<Record<string, FixtureIndividualDraft>>({});
  const [nodeErrors, setNodeErrors] = useState<Record<string, string>>({});
  const [reconcileConfirmations, setReconcileConfirmations] = useState<string[]>([]);
  const [isRestartingScan, setIsRestartingScan] = useState(false);
  const invalidatedProvisionedNodes = useRef(new Set<string>());
  const invalidatedSessionId = useRef<string | null>(null);
  const floor = dashboard?.floors.find((item) => item.id === selectedFloorId);
  const gateway = dashboard?.gateways.find((item) => item.id === selectedGatewayId);
  const hasFixtures = (dashboard?.summary.totalFixtures ?? 0) > 0;

  const activeSessionsQuery = useQuery({
    queryKey: ["registration-sessions", "active", dashboard?.site.id],
    queryFn: () => getActiveRegistrationSessions(dashboard!.site.id),
    enabled: Boolean(dashboard?.site.id)
  });

  const sessionQuery = useQuery<RegistrationSession, Error, RegistrationSession, readonly ["registration-session", string | undefined]>({
    queryKey: ["registration-session", session?.id],
    queryFn: () => getRegistrationSession(session!.id),
    enabled: Boolean(session?.id),
    refetchInterval: (query) => shouldPollRegistrationSession(query.state.data ?? session, localNodes) ? 1500 : false
  });
  const sessionSnapshot = sessionQuery.data ?? session;

  useEffect(() => {
    if (session?.status === "active" || !activeSessionsQuery.data?.[0]) return;
    restoreSession(activeSessionsQuery.data[0]);
  }, [activeSessionsQuery.data, session]);

  const nodes = useMemo(() => {
    if (isRestartingScan || !sessionSnapshot) return [];
    const historicUnresolvedNodes = (sessionSnapshot.discoveredNodes ?? []).filter((node) =>
      (node.status === "provisioning" || node.status === "reconcile_required")
      && (node.scanCorrelationId !== sessionSnapshot.scanCorrelationId || node.scanAttempt !== sessionSnapshot.scanAttempt)
    );
    if (sessionSnapshot.scanStatus !== "completed") return historicUnresolvedNodes;
    const remoteNodes = currentScanNodes(sessionSnapshot);
    const currentNodeIds = new Set(remoteNodes.map((node) => node.id));
    const byId = new Map(
      localNodes.filter((node) => currentNodeIds.has(node.id)).map((node) => [node.id, node])
    );
    for (const node of remoteNodes) {
      const localNode = byId.get(node.id);
      if (!localNode || statusProgress[node.status] >= statusProgress[localNode.status]) byId.set(node.id, node);
    }
    const currentNodes = Array.from(byId.values());
    return [...currentNodes, ...historicUnresolvedNodes.filter((node) => !currentNodeIds.has(node.id))];
  }, [isRestartingScan, localNodes, sessionSnapshot]);

  useEffect(() => {
    if (!sessionSnapshot || invalidatedSessionId.current === sessionSnapshot.id) return;
    invalidatedSessionId.current = sessionSnapshot.id;
    invalidatedProvisionedNodes.current.clear();
  }, [sessionSnapshot?.id]);

  useEffect(() => {
    if (!sessionSnapshot) return;
    const newProvisionedNodeIds = nodes
      .filter((node) => node.status === "provisioned" && !invalidatedProvisionedNodes.current.has(node.id))
      .map((node) => node.id);
    if (newProvisionedNodeIds.length === 0) return;
    newProvisionedNodeIds.forEach((nodeId) => invalidatedProvisionedNodes.current.add(nodeId));
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["floor-fixtures", sessionSnapshot.siteId, sessionSnapshot.floorId] }),
      queryClient.invalidateQueries({ queryKey: ["floor-map", sessionSnapshot.siteId, sessionSnapshot.floorId] }),
      queryClient.invalidateQueries({ queryKey: ["registration-session", sessionSnapshot.id] })
    ]);
  }, [dashboardQuerySiteId, nodes, queryClient, sessionSnapshot]);

  useEffect(() => {
    if (!floor) return;
    const namePrefix = `${floor.name}-L`;
    setBatchDefaults((current) => ({ ...current, namePrefix }));
    setIndividualDefaults((current) => ({ ...current, namePrefix }));
  }, [floor?.id]);

  useEffect(() => {
    const submitted = new Set(submittedNodeIds);
    const reviewIds = nodes
      .filter((node) => submitted.has(node.id) && (node.status === "failed" || node.status === "reconcile_required"))
      .map((node) => node.id);
    if (reviewIds.length === 0) return;
    setSelectedNodeIds((current) => {
      const next = new Set(current);
      reviewIds.forEach((id) => next.add(id));
      return next.size === current.length ? current : Array.from(next);
    });
  }, [nodes, submittedNodeIds]);

  const startMutation = useMutation({
    mutationFn: () => createRegistrationSession(dashboard!.site.id, floor!.id, gateway!.id),
    onSuccess: (created) => {
      setSession(created);
      setLocalNodes(created.discoveredNodes);
      setSelectedNodeIds([]);
      setSubmittedNodeIds([]);
      setNodeErrors({});
      setReconcileConfirmations([]);
      queryClient.setQueryData(["registration-session", created.id], created);
      queryClient.setQueryData<RegistrationSession[]>(
        ["registration-sessions", "active", created.siteId],
        (current = []) => [created, ...current.filter((item) => item.id !== created.id)]
      );
    }
  });

  const retryMutation = useMutation({
    mutationFn: () => retryRegistrationScan(session!.id),
    onMutate: () => {
      setIsRestartingScan(true);
      clearRegistrationCandidates();
    },
    onSuccess: (restarted) => {
      const canonicalPending: RegistrationSession = { ...restarted, discoveredNodes: [] };
      setSession(canonicalPending);
      setIsRestartingScan(false);
      clearRegistrationCandidates();
      queryClient.setQueryData(["registration-session", restarted.id], canonicalPending);
      void queryClient.invalidateQueries({
        queryKey: ["registration-session", restarted.id],
        exact: true
      });
    },
    onError: () => {
      setIsRestartingScan(false);
      if (session?.id) {
        void queryClient.invalidateQueries({ queryKey: ["registration-session", session.id], exact: true });
      }
    }
  });

  const registerMutation = useMutation({
    mutationFn: (input: RegisterFixtureBatchInput) => registerFixtureBatch(session!.id, input),
    onMutate: (input) => setSubmittedNodeIds((current) => Array.from(new Set([
      ...current,
      ...input.nodes.map((node) => node.nodeId)
    ]))),
    onSuccess: (result) => {
      const accepted = new Set(result.items.filter((item) => item.status === "accepted").map((item) => item.nodeId));
      setLocalNodes((current) => markNodesProvisioning(current, accepted));
      queryClient.setQueryData<RegistrationSession>(
        ["registration-session", session?.id],
        (current) => current
          ? { ...current, discoveredNodes: markNodesProvisioning(current.discoveredNodes, accepted) }
          : current
      );
      setSelectedNodeIds((current) => current.filter((id) => !accepted.has(id)));
      setNodeErrors((current) => {
        const next = { ...current };
        for (const item of result.items) {
          if (item.status === "validation_failed") next[item.nodeId] = item.error ?? "등록 정보를 확인해주세요.";
          else delete next[item.nodeId];
        }
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ["registration-session", session?.id] });
    }
  });

  const completeMutation = useMutation({
    mutationFn: () => completeRegistrationSession(session!.id),
    onSuccess: (completed) => {
      queryClient.setQueryData(["registration-session", completed.id], completed);
      continueWithRemainingSession(completed);
      void queryClient.invalidateQueries({ queryKey: ["registration-sessions", "active", completed.siteId] });
      const dashboardQueryKeys = new Set([completed.siteId, dashboardQuerySiteId ?? "default"]);
      void Promise.all([
        ...Array.from(dashboardQueryKeys, (siteKey) => queryClient.invalidateQueries({ queryKey: ["dashboard", siteKey] })),
        queryClient.invalidateQueries({ queryKey: ["floor-fixtures", completed.siteId, completed.floorId] }),
        queryClient.invalidateQueries({ queryKey: ["floor-map", completed.siteId, completed.floorId] })
      ]);
    }
  });

  const excludeMutation = useMutation({
    mutationFn: (nodeId: string) => excludeRegistrationNode(session!.id, nodeId),
    onSuccess: (updatedNode) => {
      setLocalNodes((current) => replaceNode(current, updatedNode));
      setSession((current) => current
        ? { ...current, discoveredNodes: replaceNode(current.discoveredNodes, updatedNode) }
        : current);
      queryClient.setQueryData<RegistrationSession>(
        ["registration-session", session?.id],
        (current) => current
          ? { ...current, discoveredNodes: replaceNode(current.discoveredNodes, updatedNode) }
          : current
      );
      setReconcileConfirmations((current) => current.filter((id) => id !== updatedNode.id));
    }
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelRegistrationSession(session!.id),
    onSuccess: (cancelled) => {
      queryClient.setQueryData(["registration-session", cancelled.id], cancelled);
      continueWithRemainingSession(cancelled);
      void queryClient.invalidateQueries({ queryKey: ["registration-sessions", "active", cancelled.siteId] });
    }
  });

  const hasActiveSession = sessionSnapshot?.status === "active";
  const canStart = Boolean(dashboard?.site.id && floor?.id && gateway?.id)
    && !activeSessionsQuery.isPending
    && !activeSessionsQuery.isError
    && !hasActiveSession
    && !startMutation.isPending;
  const selectedNodes = nodes.filter((node) => selectedNodeIds.includes(node.id));
  const actionableNodes = selectedNodes.filter((node) => isRegisterableNode(node, sessionSnapshot));
  const selectableNodes = nodes.filter((node) => isRegisterableNode(node, sessionSnapshot));
  const individualItems = selectedNodes.map((node) => {
    const index = nodes.findIndex((candidate) => candidate.id === node.id);
    return {
      nodeId: node.id,
      label: `조명 ${index + 1}`,
      serialNumber: node.serialNumber,
      editable: isRegisterableNode(node, sessionSnapshot),
      draft: individualDrafts[node.id] ?? createIndividualDraft(),
      error: displayTransportMessage(nodeErrors[node.id] ?? node.errorMessage)
    };
  });
  const sessionNodes = sessionSnapshot?.discoveredNodes ?? [];
  const hasProvisionedNode = sessionNodes.some((node) => node.status === "provisioned");
  const hasUnresolvedNode = sessionNodes.some((node) => node.status === "provisioning" || node.status === "reconcile_required");
  const isTerminalScan = sessionSnapshot?.scanStatus === "completed" || sessionSnapshot?.scanStatus === "failed";
  const steps = sessionSnapshot ? registrationSteps(sessionSnapshot, nodes) : initialRegistrationSteps;

  function toggleNode(nodeId: string) {
    setSelectedNodeIds((current) => current.includes(nodeId)
      ? current.filter((id) => id !== nodeId)
      : [...current, nodeId]);
    setNodeErrors((current) => {
      if (!current[nodeId]) return current;
      const next = { ...current };
      delete next[nodeId];
      return next;
    });
  }

  function toggleAllNodes() {
    const selectableIds = selectableNodes.map((node) => node.id);
    const allSelected = selectableIds.every((id) => selectedNodeIds.includes(id));
    setSelectedNodeIds((current) => allSelected
      ? current.filter((id) => !selectableIds.includes(id))
      : Array.from(new Set([...current, ...selectableIds])));
  }

  function updateIndividualDraft(nodeId: string, patch: Partial<FixtureIndividualDraft>) {
    setIndividualDrafts((current) => ({
      ...current,
      [nodeId]: { ...(current[nodeId] ?? createIndividualDraft()), ...patch }
    }));
  }

  function clearRegistrationCandidates() {
    setLocalNodes([]);
    setSelectedNodeIds([]);
    setSubmittedNodeIds([]);
    setIndividualDrafts({});
    setNodeErrors({});
    setReconcileConfirmations([]);
  }

  function restoreSession(restored: RegistrationSession) {
    setSession(restored);
    setLocalNodes(restored.discoveredNodes);
    setSelectedFloorId(restored.floorId);
    setSelectedGatewayId(restored.gatewayId);
    setSelectedNodeIds([]);
    setSubmittedNodeIds([]);
    setNodeErrors({});
    setReconcileConfirmations([]);
  }

  function selectRestoredSession(sessionId: string) {
    const restored = activeSessionsQuery.data?.find((item) => item.id === sessionId);
    if (restored) restoreSession(restored);
  }

  function continueWithRemainingSession(terminalSession: RegistrationSession) {
    const activeKey = ["registration-sessions", "active", terminalSession.siteId] as const;
    const remaining = (queryClient.getQueryData<RegistrationSession[]>(activeKey) ?? activeSessionsQuery.data ?? [])
      .filter((item) => item.id !== terminalSession.id);
    queryClient.setQueryData(activeKey, remaining);
    if (remaining[0]) restoreSession(remaining[0]);
    else setSession(terminalSession);
  }

  function submitRegistration() {
    if (actionableNodes.length === 0) return;
    if (mode === "batch") {
      registerMutation.mutate({
        mode: "batch",
        defaults: batchDefaults,
        nodes: actionableNodes.map((node) => ({ nodeId: node.id }))
      });
      return;
    }

    const registrationNodes = actionableNodes.map((node) => {
      const draft = individualDrafts[node.id] ?? createIndividualDraft();
      return {
        nodeId: node.id,
        fixtureName: draft.fixtureName,
        ratedWatt: draft.ratedWatt,
        size: draft.size
      };
    });
    registerMutation.mutate({ mode: "individual", defaults: individualDefaults, nodes: registrationNodes });
  }

  return (
    <section className={hasFixtures ? "registration-panel" : "registration-panel empty-site"}>
      <div className="panel-title-row">
        <div>
          <span className="eyebrow">BLE Mesh Provisioning</span>
          <h3>조명 등록</h3>
        </div>
        {sessionSnapshot ? (
          <span role="status" aria-label="조명 검색 상태">
            <StatusBadge tone={scanStatusTone(sessionSnapshot)} icon={scanStatusIcon(sessionSnapshot)}>{scanStatusLabel(sessionSnapshot)}</StatusBadge>
          </span>
        ) : <StatusBadge tone="neutral" icon={Clock3}>준비됨</StatusBadge>}
      </div>

      <ProgressSteps label="조명 등록 진행" steps={steps} />

      <Card className="registration-summary">
        <div>
          <strong>{floor?.name ?? "등록 대상 선택"}</strong>
          <span>{hasFixtures ? "추가 조명을 검색해 등록합니다." : "등록된 조명이 없어 먼저 검색을 시작합니다."}</span>
          {!floor || !gateway ? <small>층과 게이트웨이를 선택해야 조명 검색을 시작할 수 있습니다.</small> : null}
        </div>
        <div className="registration-targets">
          {(activeSessionsQuery.data?.length ?? 0) > 1 ? (
            <label>
              진행 중인 세션
              <select value={session?.id ?? ""} onChange={(event) => selectRestoredSession(event.target.value)}>
                {activeSessionsQuery.data?.map((item) => (
                  <option key={item.id} value={item.id}>{item.id.slice(0, 8)}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            등록 층
            <select disabled={hasActiveSession} value={selectedFloorId} onChange={(event) => setSelectedFloorId(event.target.value)}>
              <option value="">층 선택</option>
              {dashboard?.floors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>
            등록 게이트웨이
            <select disabled={hasActiveSession} value={selectedGatewayId} onChange={(event) => setSelectedGatewayId(event.target.value)}>
              <option value="">게이트웨이 선택</option>
              {dashboard?.gateways.map((item) => (
                <option key={item.id} value={item.id}>{item.name}{item.connectionStatus === "online" ? "" : " (오프라인)"}</option>
              ))}
            </select>
          </label>
        </div>
        <Button variant="primary" disabled={!canStart} isLoading={startMutation.isPending} loadingLabel="조명 검색 시작 중" onClick={() => startMutation.mutate()}>
          <Radar size={16} />
          조명 검색 시작
        </Button>
      </Card>

      {startMutation.error ? <FeedbackState tone="danger" icon={CircleAlert} title="조명 검색 세션을 시작하지 못했습니다." /> : null}
      {activeSessionsQuery.error ? (
        <FeedbackState tone="danger" icon={CircleAlert} title="진행 중인 등록 세션을 확인하지 못했습니다." action={<Button variant="ghost" onClick={() => activeSessionsQuery.refetch()}>다시 시도</Button>} />
      ) : null}

      {session && sessionSnapshot ? (
        <Card className="registration-session">
          <div className="session-meta">
            <span>등록 세션</span>
            <strong>{session.id.slice(0, 8)}</strong>
            <small>{nodes.length}개 후보 발견</small>
            {nodes.some((node) => node.status === "reconcile_required") ? (
              <Button
                variant="secondary"
                isLoading={sessionQuery.isFetching}
                loadingLabel="상태 확인 중"
                onClick={() => sessionQuery.refetch()}
              >
                상태 다시 확인
              </Button>
            ) : null}
            {sessionSnapshot.scanStatus === "completed" && nodes.length > 0 && !hasUnresolvedNode ? (
              <Button variant="secondary" disabled={retryMutation.isPending} isLoading={retryMutation.isPending} loadingLabel="다시 검색 중" onClick={() => retryMutation.mutate()}>
                <Radar size={15} />
                다시 검색
              </Button>
            ) : null}
          </div>
          {sessionSnapshot.scanStatus === "failed" ? (
            <div className="node-row muted-node" role="alert">
              <span>{safeScanFailureMessage(sessionSnapshot.scanFailureMessage)}</span>
              <Button variant="secondary" disabled={retryMutation.isPending} isLoading={retryMutation.isPending} loadingLabel="다시 검색 중" onClick={() => retryMutation.mutate()}>
                <Radar size={15} />
                다시 검색
              </Button>
            </div>
          ) : null}
          {sessionSnapshot.scanStatus === "completed" && nodes.length === 0 ? (
            <div className="node-row muted-node">
              <span>검색된 미등록 조명이 없습니다.</span>
              <Button variant="secondary" disabled={retryMutation.isPending} isLoading={retryMutation.isPending} loadingLabel="다시 검색 중" onClick={() => retryMutation.mutate()}>
                <Radar size={15} />
                다시 검색
              </Button>
            </div>
          ) : null}
          {nodes.length > 0 ? (
            <div className="registration-selection-toolbar">
              <label className="selection-checkbox">
                <input
                  type="checkbox"
                  checked={selectableNodes.length > 0 && selectableNodes.every((node) => selectedNodeIds.includes(node.id))}
                  onChange={toggleAllNodes}
                />
                등록 가능 조명 전체 선택
              </label>
              <strong>{selectedNodeIds.length}개 선택</strong>
            </div>
          ) : null}
          <div className="registration-node-list">
            {nodes.length === 0 && sessionSnapshot.scanStatus !== "completed" && sessionSnapshot.scanStatus !== "failed" ? (
              <div className="node-row muted-node">게이트웨이가 미등록 조명을 검색하는 중입니다.</div>
            ) : (
              nodes.map((node, index) => {
                const rowError = displayTransportMessage(nodeErrors[node.id]
                  ?? ((node.status === "failed" || node.status === "reconcile_required") ? node.errorMessage : null));
                return (
                  <div className={`node-row${selectedNodeIds.includes(node.id) ? " selected" : ""}`} key={node.id}>
                    <label className="node-selection">
                      <input
                        type="checkbox"
                        aria-label={`조명 ${index + 1} 선택`}
                        checked={selectedNodeIds.includes(node.id)}
                        disabled={!isRegisterableNode(node, sessionSnapshot)}
                        onChange={() => toggleNode(node.id)}
                      />
                    </label>
                    <div className="node-identity">
                      <strong>{node.serialNumber}</strong>
                      <span>{node.deviceUuid}</span>
                      <small>RSSI {node.rssi} dBm</small>
                      {rowError ? <small className="danger-text">{rowError}</small> : null}
                    </div>
                    <StatusBadge className={`node-status ${node.status}`} tone={nodeStatusTone(node.status)} icon={nodeStatusIcon(node.status)}>
                      {statusLabels[node.status]}
                    </StatusBadge>
                    {node.status === "reconcile_required" ? (
                      <div className="reconcile-actions">
                        <small>장비의 실제 등록 상태를 확인하기 전에는 다시 등록하지 마세요.</small>
                        <label>
                          <input
                            type="checkbox"
                            aria-label="장비 상태를 확인했으며 현재 세션에서 제외"
                            checked={reconcileConfirmations.includes(node.id)}
                            onChange={(event) => setReconcileConfirmations((current) => event.target.checked
                              ? [...current, node.id]
                              : current.filter((id) => id !== node.id))}
                          />
                          장비가 등록되지 않았거나 초기화된 상태임을 확인
                        </label>
                        <Button
                          variant="secondary"
                          disabled={
                            !reconcileConfirmations.includes(node.id)
                            || excludeMutation.isPending
                            || sessionQuery.isError
                          }
                          onClick={() => excludeMutation.mutate(node.id)}
                        >
                          현재 세션에서 제외
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
          {nodes.length > 0 && sessionSnapshot.scanStatus !== "failed" ? (
            <div className="registration-config">
              <div className="registration-mode-toggle" role="radiogroup" aria-label="조명 설정 방식">
                <label className={mode === "batch" ? "active" : ""}>
                  <input
                    type="radio"
                    name="registration-mode"
                    checked={mode === "batch"}
                    onChange={() => setMode("batch")}
                  />
                  일괄 설정
                </label>
                <label className={mode === "individual" ? "active" : ""}>
                  <input
                    type="radio"
                    name="registration-mode"
                    checked={mode === "individual"}
                    onChange={() => setMode("individual")}
                  />
                  개별 설정
                </label>
              </div>
              {mode === "batch" ? (
                <FixtureBatchForm
                  values={batchDefaults}
                  selectedCount={actionableNodes.length}
                  disabled={actionableNodes.length === 0 || sessionSnapshot.status !== "active"}
                  pending={registerMutation.isPending}
                  onChange={setBatchDefaults}
                  onSubmit={submitRegistration}
                />
              ) : (
                <FixtureIndividualForm
                  defaults={individualDefaults}
                  items={individualItems}
                  actionableCount={actionableNodes.length}
                  disabled={actionableNodes.length === 0 || sessionSnapshot.status !== "active"}
                  pending={registerMutation.isPending}
                  onDefaultsChange={setIndividualDefaults}
                  onDraftChange={updateIndividualDraft}
                  onSubmit={submitRegistration}
                />
              )}
              {registerMutation.error ? <FeedbackState tone="danger" icon={CircleAlert} title="선택한 조명 등록 요청을 처리하지 못했습니다." /> : null}
            </div>
          ) : null}
          {sessionSnapshot.status === "active" ? (
            <Button
              variant="ghost"
              disabled={!isTerminalScan || hasUnresolvedNode || completeMutation.isPending || cancelMutation.isPending}
              onClick={() => hasProvisionedNode ? completeMutation.mutate() : cancelMutation.mutate()}
            >
              {hasProvisionedNode ? "등록 세션 완료" : "등록 세션 취소"}
            </Button>
          ) : null}
          {excludeMutation.error ? <FeedbackState tone="danger" icon={CircleAlert} title="노드를 현재 세션에서 제외하지 못했습니다." /> : null}
          {cancelMutation.error ? <FeedbackState tone="danger" icon={CircleAlert} title="등록 세션을 취소하지 못했습니다." /> : null}
          {sessionQuery.error ? <FeedbackState tone="danger" icon={CircleAlert} title="등록 세션 상태를 다시 확인하지 못했습니다." /> : null}
        </Card>
      ) : null}
    </section>
  );
}

function markNodesProvisioning(nodes: DiscoveredRegistrationNode[], accepted: Set<string>) {
  return nodes.map((node): DiscoveredRegistrationNode => accepted.has(node.id)
    ? { ...node, status: "provisioning", errorMessage: null }
    : node);
}

function replaceNode(nodes: DiscoveredRegistrationNode[], updatedNode: DiscoveredRegistrationNode) {
  return nodes.map((node) => node.id === updatedNode.id ? updatedNode : node);
}

function createIndividualDraft(): FixtureIndividualDraft {
  return { fixtureName: "", ratedWatt: "40.00", size: 20 };
}

function isRegisterableNode(node: DiscoveredRegistrationNode, session: RegistrationSession | null) {
  return session?.status === "active" && session.scanStatus === "completed" && node.status === "discovered";
}

export function shouldPollRegistrationSession(session: RegistrationSession | null | undefined, localNodes: DiscoveredRegistrationNode[]) {
  if (!session || session.status !== "active") return false;
  return session.scanStatus === "pending"
    || session.scanStatus === "scanning"
    || session.discoveredNodes?.some((node) => node.status === "provisioning")
    || localNodes.some((node) => node.status === "provisioning");
}

function currentScanNodes(session: RegistrationSession) {
  if (!session.scanCorrelationId) return [];
  return (session.discoveredNodes ?? []).filter((node) =>
    node.scanCorrelationId !== null
    && node.scanAttempt !== null
    && node.scanCorrelationId === session.scanCorrelationId
    && node.scanAttempt === session.scanAttempt);
}

function scanStatusLabel(session: RegistrationSession | null) {
  if (!session) return "준비됨";
  if (session.scanStatus === "completed") return "검색 완료";
  if (session.scanStatus === "failed") return "검색 실패";
  return "검색 중";
}

function safeScanFailureMessage(message: string | null) {
  return displayTransportMessage(message) || "조명 검색 중 문제가 발생했습니다. 다시 검색하세요.";
}

function displayTransportMessage(message: string | null | undefined) {
  const trimmed = message?.trim();
  return trimmed ? humanizeTransportMessage(trimmed) : undefined;
}

const initialRegistrationSteps: readonly ProgressStep[] = [
  { id: "scan", label: "조명 검색", state: "current" },
  { id: "configure", label: "등록 정보", state: "pending" },
  { id: "provision", label: "장비 등록", state: "pending" },
  { id: "reconcile", label: "상태 확인", state: "pending" }
];

export function registrationSteps(session: RegistrationSession, nodes: DiscoveredRegistrationNode[]): ProgressStep[] {
  const reachableStates = reachableRegistrationStepStates(session, nodes);
  switch (session.status) {
    case "active":
      return registrationStepStates(reachableStates);
    case "completed":
      return registrationStepStates(["complete", "complete", "complete", "complete"]);
    case "cancelled":
      return registrationStepStates(reachableStates.map((state) => state === "current" ? "pending" : state));
    case "failed":
      return registrationStepStates(reachableStates.map((state) => state === "current" ? "error" : state));
    default: {
      const unhandledStatus: never = session.status;
      return unhandledStatus;
    }
  }
}

function reachableRegistrationStepStates(
  session: RegistrationSession,
  nodes: DiscoveredRegistrationNode[]
): ProgressStepState[] {
  if (session.scanStatus === "failed") return ["error", "pending", "pending", "pending"];
  if (session.scanStatus !== "completed") return ["current", "pending", "pending", "pending"];
  if (nodes.some((node) => node.status === "reconcile_required")) {
    return ["complete", "complete", "complete", "current"];
  }
  if (nodes.some((node) => node.status === "failed")) {
    return ["complete", "complete", "error", "pending"];
  }
  if (nodes.some((node) => node.status === "provisioning")) {
    return ["complete", "complete", "current", "pending"];
  }
  if (nodes.some((node) => node.status === "provisioned")) {
    return ["complete", "complete", "complete", "current"];
  }
  return ["complete", "current", "pending", "pending"];
}

function registrationStepStates(states: readonly ProgressStepState[]): ProgressStep[] {
  return ["조명 검색", "등록 정보", "장비 등록", "상태 확인"].map((label, index) => ({
    id: ["scan", "configure", "provision", "reconcile"][index],
    label,
    state: states[index]
  }));
}

function scanStatusTone(session: RegistrationSession | null) {
  if (session?.scanStatus === "failed") return "danger" as const;
  if (session?.scanStatus === "completed") return "success" as const;
  return "info" as const;
}

function scanStatusIcon(session: RegistrationSession | null) {
  if (session?.scanStatus === "failed") return CircleAlert;
  if (session?.scanStatus === "completed") return CircleCheck;
  return Clock3;
}

function nodeStatusTone(status: DiscoveredRegistrationNode["status"]) {
  if (status === "failed" || status === "reconcile_required") return "danger" as const;
  if (status === "provisioned") return "success" as const;
  if (status === "provisioning" || status === "identifying") return "warning" as const;
  return "info" as const;
}

function nodeStatusIcon(status: DiscoveredRegistrationNode["status"]) {
  if (status === "failed" || status === "reconcile_required") return CircleAlert;
  if (status === "provisioned") return CircleCheck;
  if (status === "provisioning" || status === "identifying") return Clock3;
  return Radar;
}
