import type { Dashboard } from "../../api/queries";

export type ControlReadiness = {
  ready: boolean;
  label: string;
  error: string | null;
};

export function floorMeshReadiness(floor: Dashboard["floors"][number]): ControlReadiness {
  const expectedGatewayIds = new Set(
    floor.fixtures.flatMap((fixture) => fixture.gateway?.id ? [fixture.gateway.id] : [])
  );
  if (expectedGatewayIds.size === 0) return { ready: false, label: "Mesh 그룹 없음", error: null };

  const relevantGroups = floor.meshControlGroups.filter((group) => expectedGatewayIds.has(group.gatewayId));
  const readyGatewayIds = new Set(
    relevantGroups.filter((group) => group.status === "ready").map((group) => group.gatewayId)
  );
  const readyCount = readyGatewayIds.size;
  const failed = relevantGroups.find((group) => group.status === "failed");

  if (failed) {
    return {
      ready: false,
      label: `Gateway ${readyCount}/${expectedGatewayIds.size} 준비 · Mesh 설정 실패`,
      error: failed.error
    };
  }
  if (readyCount !== expectedGatewayIds.size) {
    return {
      ready: false,
      label: `Gateway ${readyCount}/${expectedGatewayIds.size} 준비 · Mesh 설정 중`,
      error: null
    };
  }
  return {
    ready: true,
    label: `Gateway ${readyCount}/${expectedGatewayIds.size} 준비 완료`,
    error: null
  };
}

export function fixtureGroupReadiness(group: Dashboard["groups"][number]): ControlReadiness {
  if (group.lifecycleStatus !== "active") return { ready: false, label: "사용 중지", error: null };
  if (group.meshControlGroup?.status === "ready") return { ready: true, label: "제어 준비 완료", error: null };
  if (group.meshControlGroup?.status === "failed") {
    return { ready: false, label: "Mesh 설정 실패", error: group.meshControlGroup.error };
  }
  return { ready: false, label: "Mesh 설정 중", error: null };
}
