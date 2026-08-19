import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Radar, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import type { Dashboard } from "../../api/queries";
import {
  completeRegistrationSession,
  createRegistrationSession,
  getRegistrationSession,
  identifyRegistrationNode,
  registerRegistrationNode,
  type DiscoveredRegistrationNode,
  type RegistrationSession
} from "../../api/registration";

interface RegistrationPanelProps {
  dashboard: Dashboard | undefined;
}

const statusLabels = {
  discovered: "발견",
  identifying: "점멸 중",
  provisioning: "등록 중",
  provisioned: "등록 완료",
  failed: "실패",
  reconcile_required: "확인 필요"
} as const;

export function RegistrationPanel({ dashboard }: RegistrationPanelProps) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<RegistrationSession | null>(null);
  const [localNodes, setLocalNodes] = useState<DiscoveredRegistrationNode[]>([]);
  const [selectedFloorId, setSelectedFloorId] = useState("");
  const [selectedGatewayId, setSelectedGatewayId] = useState("");
  const floor = dashboard?.floors.find((item) => item.id === selectedFloorId);
  const gateway = dashboard?.gateways.find((item) => item.id === selectedGatewayId);
  const hasFixtures = (dashboard?.summary.totalFixtures ?? 0) > 0;

  const sessionQuery = useQuery({
    queryKey: ["registration-session", session?.id],
    queryFn: () => getRegistrationSession(session!.id),
    enabled: Boolean(session?.id),
    refetchInterval: session?.status === "active" ? 1500 : false
  });

  const nodes = useMemo(() => {
    const remoteNodes = sessionQuery.data?.discoveredNodes ?? session?.discoveredNodes ?? [];
    const byId = new Map(remoteNodes.map((node) => [node.id, node]));
    for (const node of localNodes) byId.set(node.id, node);
    return Array.from(byId.values());
  }, [localNodes, session?.discoveredNodes, sessionQuery.data?.discoveredNodes]);

  const startMutation = useMutation({
    mutationFn: () => createRegistrationSession(dashboard!.site.id, floor!.id, gateway!.id),
    onSuccess: (created) => {
      setSession(created);
      setLocalNodes(created.discoveredNodes);
    }
  });

  const identifyMutation = useMutation({
    mutationFn: (nodeId: string) => identifyRegistrationNode(session!.id, nodeId),
    onSuccess: (node) => setLocalNodes((current) => upsertNode(current, node))
  });

  const registerMutation = useMutation({
    mutationFn: (node: DiscoveredRegistrationNode) =>
      registerRegistrationNode(session!.id, node.id, nextFixtureName(dashboard, nodes, floor), 180 + nodes.length * 36, 180),
    onSuccess: (result) => {
      setLocalNodes((current) => upsertNode(current, result.discoveredNode));
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
  });

  const completeMutation = useMutation({
    mutationFn: () => completeRegistrationSession(session!.id),
    onSuccess: (completed) => setSession(completed)
  });

  const canStart = Boolean(dashboard?.site.id && floor?.id && gateway?.id) && !startMutation.isPending;

  return (
    <section className={hasFixtures ? "registration-panel" : "registration-panel empty-site"}>
      <div className="panel-title-row">
        <div>
          <span className="eyebrow">BLE Mesh Provisioning</span>
          <h3>조명 등록</h3>
        </div>
        <span className="status-pill online">{session?.status === "active" ? "검색 중" : "준비됨"}</span>
      </div>

      <div className="registration-summary">
        <div>
          <strong>{floor?.name ?? "등록 대상 선택"}</strong>
          <span>{hasFixtures ? "추가 조명을 검색해 등록합니다." : "등록된 조명이 없어 먼저 검색을 시작합니다."}</span>
          {!floor || !gateway ? <small>층과 게이트웨이를 선택해야 조명 검색을 시작할 수 있습니다.</small> : null}
        </div>
        <div className="registration-targets">
          <label>
            등록 층
            <select value={selectedFloorId} onChange={(event) => setSelectedFloorId(event.target.value)}>
              <option value="">층 선택</option>
              {dashboard?.floors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>
            등록 게이트웨이
            <select value={selectedGatewayId} onChange={(event) => setSelectedGatewayId(event.target.value)}>
              <option value="">게이트웨이 선택</option>
              {dashboard?.gateways.map((item) => (
                <option key={item.id} value={item.id}>{item.name}{item.connectionStatus === "online" ? "" : " (오프라인)"}</option>
              ))}
            </select>
          </label>
        </div>
        <button className="primary-button" disabled={!canStart} onClick={() => startMutation.mutate()}>
          {startMutation.isPending ? <Loader2 size={16} /> : <Radar size={16} />}
          조명 검색 시작
        </button>
      </div>

      {startMutation.error ? <p className="danger-text">조명 검색 세션을 시작하지 못했습니다.</p> : null}

      {session ? (
        <div className="registration-session">
          <div className="session-meta">
            <span>등록 세션</span>
            <strong>{session.id.slice(0, 8)}</strong>
            <small>{nodes.length}개 후보 발견</small>
          </div>
          <div className="registration-node-list">
            {nodes.length === 0 ? (
              <div className="node-row muted-node">게이트웨이가 미등록 조명을 검색하는 중입니다.</div>
            ) : (
              nodes.map((node) => (
                <div className="node-row" key={node.id}>
                  <div>
                    <strong>{node.serialNumber}</strong>
                    <span>{node.deviceUuid}</span>
                    <small>RSSI {node.rssi} dBm</small>
                  </div>
                  <span className={`node-status ${node.status}`}>{statusLabels[node.status]}</span>
                  <button
                    className="secondary-button"
                    disabled={node.status === "provisioned" || identifyMutation.isPending}
                    onClick={() => identifyMutation.mutate(node.id)}
                  >
                    <Sparkles size={15} />
                    점멸 확인
                  </button>
                  <button
                    className="secondary-button"
                    disabled={node.status === "provisioned" || registerMutation.isPending}
                    onClick={() => registerMutation.mutate(node)}
                  >
                    <CheckCircle2 size={15} />
                    등록
                  </button>
                </div>
              ))
            )}
          </div>
          <button
            className="link-button"
            disabled={!nodes.some((node) => node.status === "provisioned") || completeMutation.isPending}
            onClick={() => completeMutation.mutate()}
          >
            등록 세션 완료
          </button>
        </div>
      ) : null}
    </section>
  );
}

function upsertNode(nodes: DiscoveredRegistrationNode[], next: DiscoveredRegistrationNode) {
  const exists = nodes.some((node) => node.id === next.id);
  if (!exists) return [...nodes, next];
  return nodes.map((node) => (node.id === next.id ? next : node));
}

function nextFixtureName(dashboard: Dashboard | undefined, nodes: DiscoveredRegistrationNode[], floor?: Dashboard["floors"][number]) {
  const floorName = floor?.name ?? "B2";
  const fixtureCount = dashboard?.summary.totalFixtures ?? 0;
  return `${floorName}-L${String(fixtureCount + nodes.filter((node) => node.status === "provisioned").length + 1).padStart(2, "0")}`;
}
