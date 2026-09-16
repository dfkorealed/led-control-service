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
  identifyRegistrationNode,
  registerFixtureBatch,
  retryRegistrationScan,
  type DiscoveredRegistrationNode,
  type RegisterFixtureBatchInput,
  type RegistrationSession
} from "../../api/registration";
import {
  Button,
  Card,
  Checkbox,
  FeedbackState,
  ProgressSteps,
  RadioGroup,
  SelectBox,
  StatusBadge,
  type ProgressStep,
  type ProgressStepState
} from "../../components/ui";
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
  headingLevel?: 2 | 3;
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
  digits: "3",
  ratedWatt: "40.00",
  size: 20
};

const initialIndividualDefaults: FixtureIndividualDefaults = {
  namePrefix: "B2-L",
  startNumber: 1,
  digits: "3"
};

export function RegistrationPanel({ dashboard, dashboardQuerySiteId, headingLevel = 3 }: RegistrationPanelProps) {
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
    if (!sessionQuery.data || sessionQuery.data.scanStatus !== "completed") return;
    const remoteNodes = currentScanNodes(sessionQuery.data);
    setLocalNodes((current) => mergeRegistrationNodeLists(current, remoteNodes));
  }, [sessionQuery.data]);

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
      byId.set(node.id, localNode ? mergeRegistrationNodeProgress(localNode, node) : node);
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

  const identifyMutation = useMutation({
    mutationFn: (nodeId: string) => identifyRegistrationNode(session!.id, nodeId),
    onSuccess: ({ operationId, node }) => {
      // The mutation receipt is the ownership boundary. Keep its ID even if a
      // compatibility presenter omitted the additive node metadata; otherwise
      // an already-in-flight poll for the previous attempt can settle a retry.
      const updatedNode = { ...node, identifyOperationId: operationId };
      setLocalNodes((current) => replaceNode(current, updatedNode));
      queryClient.setQueryData<RegistrationSession>(
        ["registration-session", session?.id],
        (current) => current
          ? { ...current, discoveredNodes: replaceNode(current.discoveredNodes, updatedNode) }
          : current
      );
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
  const preExistingRegistrationNodes = nodes.filter(isPreExistingRegistrationNode);
  const unknownEligibilityNodes = nodes.filter((node) => !hasKnownRegistrationEligibility(node));
  const hiddenUnknownEligibilityNodes = unknownEligibilityNodes.filter((node) => !isRegistrationProgressNode(node));
  const excludedNodeCount = preExistingRegistrationNodes.length + hiddenUnknownEligibilityNodes.length;
  const visibleNodes = nodes.filter((node) => hasKnownRegistrationEligibility(node)
    ? !isPreExistingRegistrationNode(node)
    : isRegistrationProgressNode(node));
  const registrationFormNodes = visibleNodes.filter(hasKnownRegistrationEligibility);
  const registeredInSiteNodes = preExistingRegistrationNodes.filter((node) => node.registrationEligibility === "registered_in_site");
  const registeredElsewhereCount = preExistingRegistrationNodes.length - registeredInSiteNodes.length;
  const selectedNodes = visibleNodes.filter((node) => selectedNodeIds.includes(node.id));
  const actionableNodes = selectedNodes.filter((node) => isRegisterableNode(node, sessionSnapshot));
  const selectableNodes = visibleNodes.filter((node) => isRegisterableNode(node, sessionSnapshot));
  const individualItems = actionableNodes.map((node) => {
    const index = visibleNodes.findIndex((candidate) => candidate.id === node.id);
    return {
      nodeId: node.id,
      label: `조명 ${index + 1}`,
      serialNumber: node.serialNumber,
      editable: isRegisterableNode(node, sessionSnapshot),
      draft: individualDrafts[node.id] ?? createIndividualDraft(),
      error: displayTransportMessage(nodeErrors[node.id] ?? node.errorMessage)
    };
  });
  // The visible list is scoped to the current scan plus unresolved historic
  // work, but completion must remember provisioned nodes from earlier scans.
  // Merge identify terminals first so stale optimistic state cannot hide them.
  const sessionNodes = (sessionSnapshot?.discoveredNodes ?? []).map((remoteNode) => {
    const localNode = localNodes.find((candidate) => candidate.id === remoteNode.id);
    return localNode ? mergeRegistrationNodeProgress(localNode, remoteNode) : remoteNode;
  });
  const hasProvisionedNode = sessionNodes.some((node) => node.status === "provisioned");
  const hasUnresolvedNode = sessionNodes.some((node) => node.status === "provisioning" || node.status === "reconcile_required");
  const isTerminalScan = sessionSnapshot?.scanStatus === "completed" || sessionSnapshot?.scanStatus === "failed";
  const steps = sessionSnapshot ? registrationSteps(sessionSnapshot, nodes) : initialRegistrationSteps;
  const Heading = headingLevel === 2 ? "h2" : "h3";

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
        defaults: {
          ...batchDefaults,
          startNumber: batchDefaults.startNumber ?? 0,
          digits: Number(batchDefaults.digits),
          size: batchDefaults.size ?? 0
        },
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
        size: draft.size ?? 0
      };
    });
    registerMutation.mutate({
      mode: "individual",
      defaults: {
        ...individualDefaults,
        startNumber: individualDefaults.startNumber ?? 0,
        digits: Number(individualDefaults.digits)
      },
      nodes: registrationNodes
    });
  }

  return (
    <section className={hasFixtures ? "registration-panel" : "registration-panel empty-site"}>
      <div className="panel-title-row">
        <div>
          <span className="eyebrow">BLE Mesh Provisioning</span>
          <Heading>조명 등록</Heading>
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
            <SelectBox
              label="진행 중인 세션"
              items={(activeSessionsQuery.data ?? []).map((item) => ({ id: item.id, label: item.id.slice(0, 8) }))}
              selectedKey={session?.id ?? null}
              onSelectionChange={(key) => { if (key) selectRestoredSession(key); }}
            />
          ) : null}
          <SelectBox
            label="등록 층"
            placeholder="층 선택"
            items={(dashboard?.floors ?? []).map((item) => ({ id: item.id, label: item.name }))}
            selectedKey={selectedFloorId || null}
            isDisabled={hasActiveSession}
            onSelectionChange={(key) => setSelectedFloorId(key ?? "")}
          />
          <SelectBox
            label="등록 게이트웨이"
            placeholder="게이트웨이 선택"
            items={(dashboard?.gateways ?? []).map((item) => ({
              id: item.id,
              label: `${item.name}${item.connectionStatus === "online" ? "" : " (오프라인)"}`
            }))}
            selectedKey={selectedGatewayId || null}
            isDisabled={hasActiveSession}
            onSelectionChange={(key) => setSelectedGatewayId(key ?? "")}
          />
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
            <small>{selectableNodes.length}개 등록 가능</small>
            {excludedNodeCount > 0 ? <small>{excludedNodeCount}개 제외</small> : null}
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
            {sessionSnapshot.scanStatus === "completed" && visibleNodes.length > 0 && !hasUnresolvedNode ? (
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
          {sessionSnapshot.scanStatus === "completed" && visibleNodes.length === 0 ? (
            <div className="node-row muted-node">
              <span>{excludedNodeCount > 0
                ? "새로 등록할 수 있는 조명이 없습니다."
                : "검색된 미등록 조명이 없습니다."}</span>
              <Button variant="secondary" disabled={retryMutation.isPending} isLoading={retryMutation.isPending} loadingLabel="다시 검색 중" onClick={() => retryMutation.mutate()}>
                <Radar size={15} />
                다시 검색
              </Button>
            </div>
          ) : null}
          {selectableNodes.length > 0 ? (
            <div className="registration-selection-toolbar">
              <Checkbox
                className="selection-checkbox"
                label="등록 가능 조명 전체 선택"
                isSelected={selectableNodes.length > 0 && selectableNodes.every((node) => selectedNodeIds.includes(node.id))}
                onChange={toggleAllNodes}
              />
              <strong>{actionableNodes.length}개 선택</strong>
            </div>
          ) : null}
          <div className="registration-node-list">
            {visibleNodes.length === 0 && sessionSnapshot.scanStatus !== "completed" && sessionSnapshot.scanStatus !== "failed" ? (
              <div className="node-row muted-node">게이트웨이가 미등록 조명을 검색하는 중입니다.</div>
            ) : (
              visibleNodes.map((node, index) => {
                const hasKnownEligibility = hasKnownRegistrationEligibility(node);
                const hidesIdentity = !hasKnownEligibility || node.registrationEligibility === "registered_elsewhere";
                const rowError = displayTransportMessage(nodeErrors[node.id]
                  ?? ((node.status === "failed" || node.status === "reconcile_required" || node.identifyState === "failed")
                    ? node.errorMessage
                    : null));
                return (
                  <div className={`node-row${isAvailableRegistrationNode(node) && selectedNodeIds.includes(node.id) ? " selected" : ""}`} key={node.id}>
                    {hasKnownEligibility ? (
                      <Checkbox
                        className="node-selection"
                        size="lg"
                        aria-label={`조명 ${index + 1} 선택`}
                        isSelected={selectedNodeIds.includes(node.id)}
                        isDisabled={!isRegisterableNode(node, sessionSnapshot)}
                        onChange={() => toggleNode(node.id)}
                      />
                    ) : <span aria-hidden="true" />}
                    <div className="node-identity">
                      {hidesIdentity ? (
                        <span>{hasKnownEligibility
                          ? "다른 현장에 등록된 장치입니다. 보안을 위해 상세 정보는 표시하지 않습니다."
                          : "등록 상태를 확인할 수 없는 장치입니다. 식별 정보는 표시하지 않습니다."}</span>
                      ) : (
                        <>
                          <strong>{node.serialNumber}</strong>
                          <span>{node.deviceUuid}</span>
                          <small>RSSI {node.rssi} dBm</small>
                          {node.status === "discovered" && node.identifyState === "confirmed" ? (
                            <small className="success-text">식별 완료</small>
                          ) : null}
                          {rowError ? <small className="danger-text">{rowError}</small> : null}
                        </>
                      )}
                    </div>
                    <StatusBadge className={`node-status ${node.status}`} tone={nodeStatusTone(node.status)} icon={nodeStatusIcon(node.status)}>
                      {statusLabels[node.status]}
                    </StatusBadge>
                    {node.status === "discovered" || node.status === "identifying" ? (
                      <Button
                        variant="secondary"
                        size="lg"
                        aria-label={`조명 ${index + 1} ${node.status === "identifying" ? "식별 중" : "식별"}`}
                        disabled={node.status === "identifying" || identifyMutation.isPending || sessionSnapshot.status !== "active"}
                        isLoading={identifyMutation.isPending && identifyMutation.variables === node.id}
                        loadingLabel="식별 요청 중"
                        onClick={() => identifyMutation.mutate(node.id)}
                      >
                        {node.status === "identifying" ? "식별 중" : "식별"}
                      </Button>
                    ) : null}
                    {node.status === "reconcile_required" ? (
                      <div className="reconcile-actions">
                        <small>장비의 실제 등록 상태를 확인하기 전에는 다시 등록하지 마세요.</small>
                        <Checkbox
                          label="장비가 등록되지 않았거나 초기화된 상태임을 확인"
                          aria-label="장비 상태를 확인했으며 현재 세션에서 제외"
                          isSelected={reconcileConfirmations.includes(node.id)}
                          onChange={(selected) => setReconcileConfirmations((current) => selected
                            ? [...current, node.id]
                            : current.filter((id) => id !== node.id))}
                        />
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
          {preExistingRegistrationNodes.length > 0 ? (
            <details className="registered-node-details">
              <summary>기존 등록 조명 {preExistingRegistrationNodes.length}개 제외됨</summary>
              <div className="registered-node-list">
                {registeredInSiteNodes.map((node) => (
                  <div className="registered-node-row" key={node.id}>
                    <strong>{node.existingRegistration?.fixtureName ?? "조명 정보 없음"}</strong>
                    <span>{node.existingRegistration?.floorName ?? "층 정보 없음"}</span>
                    <small>{node.serialNumber}</small>
                  </div>
                ))}
                {registeredElsewhereCount > 0 ? (
                  <div className="registered-elsewhere-notice">
                    <strong>다른 현장 등록 {registeredElsewhereCount}개</strong>
                    <span>다른 현장에 등록된 장치입니다. 보안을 위해 상세 정보는 표시하지 않습니다.</span>
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}
          {hiddenUnknownEligibilityNodes.length > 0 ? (
            <p className="registration-eligibility-warning">
              등록 상태를 확인할 수 없는 장치 {hiddenUnknownEligibilityNodes.length}개를 제외했습니다.
            </p>
          ) : null}
          {registrationFormNodes.length > 0 && sessionSnapshot.scanStatus !== "failed" ? (
            <div className="registration-config">
              <RadioGroup
                className="registration-mode-toggle"
                aria-label="조명 설정 방식"
                orientation="horizontal"
                value={mode}
                onChange={(value) => setMode(value as RegistrationMode)}
                items={[
                  { value: "batch", label: "일괄 설정" },
                  { value: "individual", label: "개별 설정" }
                ]}
              />
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
          {identifyMutation.error ? <FeedbackState tone="danger" icon={CircleAlert} title="조명 식별 요청을 처리하지 못했습니다." /> : null}
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

function hasKnownRegistrationEligibility(node: DiscoveredRegistrationNode) {
  const eligibility: unknown = node.registrationEligibility;
  return eligibility === "available"
    || eligibility === "registered_in_site"
    || eligibility === "registered_elsewhere";
}

function isAvailableRegistrationNode(node: DiscoveredRegistrationNode) {
  return node.registrationEligibility === "available";
}

function isRegistrationProgressNode(node: DiscoveredRegistrationNode) {
  return node.status === "provisioning"
    || node.status === "provisioned"
    || node.status === "reconcile_required";
}

export function isPreExistingRegistrationNode(node: DiscoveredRegistrationNode) {
  if (!hasKnownRegistrationEligibility(node) || isAvailableRegistrationNode(node)) return false;
  return !isRegistrationProgressNode(node);
}

function isRegisterableNode(node: DiscoveredRegistrationNode, session: RegistrationSession | null) {
  return session?.status === "active"
    && session.scanStatus === "completed"
    && node.status === "discovered"
    && isAvailableRegistrationNode(node);
}

export function shouldPollRegistrationSession(session: RegistrationSession | null | undefined, localNodes: DiscoveredRegistrationNode[]) {
  if (!session || session.status !== "active") return false;
  const localById = new Map(localNodes.map((node) => [node.id, node]));
  const remoteById = new Map((session.discoveredNodes ?? []).map((node) => [node.id, node]));
  const remoteInProgress = [...remoteById.values()].some((remoteNode) => {
    const effective = localById.has(remoteNode.id)
      ? mergeRegistrationNodeProgress(localById.get(remoteNode.id)!, remoteNode)
      : remoteNode;
    return effective.status === "identifying" || effective.status === "provisioning";
  });
  const localOnlyInProgress = localNodes.some((localNode) => {
    const remoteNode = remoteById.get(localNode.id);
    const effective = remoteNode ? mergeRegistrationNodeProgress(localNode, remoteNode) : localNode;
    return effective.status === "identifying" || effective.status === "provisioning";
  });
  return session.scanStatus === "pending"
    || session.scanStatus === "scanning"
    || remoteInProgress
    || localOnlyInProgress;
}

function mergeRegistrationNodeLists(
  localNodes: DiscoveredRegistrationNode[],
  remoteNodes: DiscoveredRegistrationNode[]
) {
  const remoteById = new Map(remoteNodes.map((node) => [node.id, node]));
  return localNodes.map((localNode) => {
    const remoteNode = remoteById.get(localNode.id);
    return remoteNode ? mergeRegistrationNodeProgress(localNode, remoteNode) : localNode;
  });
}

export function mergeRegistrationNodeProgress(
  localNode: DiscoveredRegistrationNode,
  remoteNode: DiscoveredRegistrationNode
) {
  const localOwner = localNode.identifyOperationId;
  const remoteOwner = remoteNode.identifyOperationId;
  if (localOwner && localOwner !== remoteOwner) {
    const localStarted = Date.parse(localNode.identifyOperationStartedAt ?? "");
    const remoteStarted = Date.parse(remoteNode.identifyOperationStartedAt ?? "");
    // Different IDs are different operations, not different progress ranks.
    // Only a positively newer server operation can replace known ownership;
    // missing/invalid metadata and delayed earlier terminals fail closed.
    if (!remoteOwner || !Number.isFinite(localStarted) || !Number.isFinite(remoteStarted) || remoteStarted <= localStarted) {
      return localNode;
    }
    if (localNode.status === "discovered" || localNode.status === "identifying") return remoteNode;
  }
  if (localOwner && localOwner === remoteOwner) {
    const localRevision = Date.parse(localNode.updatedAt ?? "");
    const remoteRevision = Date.parse(remoteNode.updatedAt ?? "");
    if (Number.isFinite(localRevision) && (!Number.isFinite(remoteRevision) || remoteRevision < localRevision)) return localNode;
  }
  const localIdentifyTerminal = localNode.status === "discovered"
    && (localNode.identifyState === "confirmed" || localNode.identifyState === "failed");
  const remoteIdentifyTerminal = remoteNode.status === "discovered"
    && (remoteNode.identifyState === "confirmed" || remoteNode.identifyState === "failed");

  // Identify intentionally returns the node to `discovered`, so its terminal
  // state is authoritative even though the generic registration status rank
  // is numerically lower than `identifying`. Conversely, a delayed poll must
  // not resurrect an operation after the terminal response was displayed.
  if (remoteIdentifyTerminal && localNode.status === "identifying") return remoteNode;
  if (localIdentifyTerminal && remoteNode.status === "identifying") return localNode;
  return statusProgress[remoteNode.status] >= statusProgress[localNode.status] ? remoteNode : localNode;
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
