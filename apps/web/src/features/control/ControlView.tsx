import { useEffect, useMemo, useState } from "react";
import type { DimmingTarget } from "@led-control/shared";
import { useQueryClient } from "@tanstack/react-query";
import type { AuthUser } from "../../api/auth";
import { createDimmingCommand, useCommandStatus, type CommandStage } from "../../api/commands";
import { useControlDashboard, type DashboardFixture } from "../../api/queries";
import { ControlTargetPicker, type ControlSelection } from "./ControlTargetPicker";

const emptySelection: ControlSelection = { mode: "fixtures", fixtureIds: [] };

export function ControlView({ siteId, userRole }: { siteId?: string; userRole: AuthUser["role"] }) {
  const { data, isLoading, error } = useControlDashboard(siteId);
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<ControlSelection>(emptySelection);
  const [brightness, setBrightness] = useState(70);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [commandId, setCommandId] = useState<string | null>(null);
  const commandQuery = useCommandStatus(commandId);
  const fixtures = useMemo(() => data?.floors.flatMap((floor) => floor.fixtures) ?? [], [data]);
  const selected = useMemo(() => resolveSelection(data, fixtures, selection), [data, fixtures, selection]);
  const blockedFixture = selected.fixtures.find((fixture) => !fixture.controllable);
  const blockMessage = blockedFixture
    ? formatControlBlockReason(blockedFixture.controlBlockReason, blockedFixture.name)
    : null;
  const readOnly = userRole === "viewer";
  const target = selected.isValid ? toDimmingTarget(selection) : null;
  const canSubmit = Boolean(data && target && selected.fixtures.length > 0 && !blockMessage && !isSubmitting && !readOnly);

  useEffect(() => {
    setSelection(emptySelection);
    setMessage("");
    setCommandId(null);
  }, [siteId]);

  async function submitCommand() {
    if (!data || !target || !canSubmit) return;

    setIsSubmitting(true);
    setMessage("");
    try {
      const command = await createDimmingCommand({ siteId: data.site.id, target, brightness });
      setCommandId(command.id);
      setMessage("명령을 전송했습니다. 장비 ACK를 기다리는 중입니다.");
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch {
      setMessage("명령 전송에 실패했습니다. 대상 상태와 게이트웨이 연결을 확인하세요.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isLoading && !data) {
    return <section className="control-screen"><p className="muted-text" role="status">제어 대상을 불러오는 중입니다.</p></section>;
  }

  if (error && !data) {
    return <section className="control-screen"><p className="danger-text" role="alert">제어 대상을 불러오지 못했습니다.</p></section>;
  }

  if (!data) {
    return <section className="control-screen"><p className="muted-text" role="status">제어 대상 데이터가 없습니다.</p></section>;
  }

  return (
    <section className="control-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">수동 제어</span>
          <h2>조명 밝기 제어</h2>
        </div>
      </div>

      {readOnly ? (
        <p className="danger-text control-readonly-notice" role="alert">
          조회 전용 계정입니다. 조명 제어는 operator 또는 admin 계정으로만 수행할 수 있습니다.
        </p>
      ) : null}

      <div className="control-layout">
        <ControlTargetPicker
          key={data.site.id}
          dashboard={data}
          selection={selection}
          disabled={readOnly || isSubmitting}
          onChange={(nextSelection) => {
            setSelection(nextSelection);
            if (nextSelection.mode === "fixtures" && nextSelection.fixtureIds.length === 1) {
              const fixture = fixtures.find((item) => item.id === nextSelection.fixtureIds[0]);
              if (fixture) setBrightness(fixture.brightness);
            }
            setMessage("");
          }}
        />

        <aside className="control-panel">
          <div className="panel-title-row">
            <div>
              <span className="eyebrow">선택 대상</span>
              <h3>{selected.name}</h3>
            </div>
            <span className={`status-pill ${canSubmit ? "online" : "offline"}`}>
              {readOnly ? "조회 전용" : canSubmit ? "전송 가능" : blockMessage ? "제어 불가" : "대상 없음"}
            </span>
          </div>

          <div className="control-target-summary" aria-live="polite">
            <strong>{selected.fixtures.length}개 선택 · 제어 불가 {selected.blockedCount}개</strong>
            <span>{deliveryLabel(selection, selected.fixtures.length)}</span>
          </div>

          <div className="dial-card">
            <span>밝기</span>
            <strong>{brightness}%</strong>
            <input
              aria-label="밝기"
              type="range"
              min="0"
              max="100"
              value={brightness}
              disabled={readOnly || isSubmitting}
              onChange={(event) => setBrightness(Number(event.target.value))}
            />
          </div>

          <div className="preset-row">
            {[0, 30, 70, 100].map((value) => (
              <button key={value} type="button" onClick={() => setBrightness(value)} disabled={readOnly || isSubmitting}>
                {value}%
              </button>
            ))}
          </div>

          <button className="primary-button" type="button" onClick={submitCommand} disabled={!canSubmit}>
            {isSubmitting ? "전송 중" : "밝기 적용"}
          </button>
          {blockMessage ? <p className="danger-text" role="alert">{blockMessage}</p> : null}
          {message ? <p className={message.startsWith("명령을 전송") ? "success-text" : "danger-text"}>{message}</p> : null}
          {commandQuery.data ? <CommandProgress status={commandQuery.data} /> : null}
          {commandQuery.error ? <p className="danger-text" role="alert">명령 처리 상태를 불러오지 못했습니다.</p> : null}
        </aside>
      </div>
    </section>
  );
}

function resolveSelection(
  data: ReturnType<typeof useControlDashboard>["data"],
  fixtures: DashboardFixture[],
  selection: ControlSelection
) {
  if (!data) return { name: "대상 선택", fixtures: [], blockedCount: 0, isValid: false };

  if (selection.mode === "fixtures") {
    const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
    const selectedFixtures = selection.fixtureIds.flatMap((id) => {
      const fixture = byId.get(id);
      return fixture ? [fixture] : [];
    });
    return selectionResult(
      selectedFixtures.length === 1 ? selectedFixtures[0].name : selectedFixtures.length > 1 ? `${selectedFixtures.length}개 조명` : "대상 선택",
      selectedFixtures,
      selection.fixtureIds.length > 0 && selectedFixtures.length === selection.fixtureIds.length
    );
  }

  if (selection.mode === "floor") {
    const floor = data.floors.find((item) => item.id === selection.floorId);
    return selectionResult(floor?.name ?? "층 선택", floor?.fixtures ?? [], Boolean(floor));
  }

  const group = data.groups.find((item) => item.id === selection.groupId);
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const groupFixtures = group?.fixtureIds.flatMap((id) => {
    const fixture = fixtureById.get(id);
    return fixture ? [fixture] : [];
  }) ?? [];
  return selectionResult(
    group?.name ?? "구역 선택",
    groupFixtures,
    Boolean(group && group.fixtureIds.length > 0 && groupFixtures.length === group.fixtureIds.length)
  );
}

function selectionResult(name: string, fixtures: DashboardFixture[], isValid: boolean) {
  return {
    name,
    fixtures,
    blockedCount: fixtures.filter((fixture) => !fixture.controllable).length,
    isValid
  };
}

function toDimmingTarget(selection: ControlSelection): DimmingTarget | null {
  if (selection.mode === "fixtures") {
    if (selection.fixtureIds.length === 0) return null;
    return selection.fixtureIds.length === 1
      ? { type: "fixture", fixtureId: selection.fixtureIds[0] }
      : { type: "fixtures", fixtureIds: selection.fixtureIds };
  }
  if (selection.mode === "floor") return selection.floorId ? { type: "floor", floorId: selection.floorId } : null;
  return selection.groupId ? { type: "group", groupId: selection.groupId } : null;
}

function deliveryLabel(selection: ControlSelection, fixtureCount: number) {
  if (selection.mode === "floor" || selection.mode === "group") return "BLE Mesh 그룹 전송";
  if (fixtureCount === 1) return "BLE Mesh 개별 전송";
  if (fixtureCount > 1) return "BLE Mesh 다중 대상 전송";
  return "대상을 선택하세요";
}

function CommandProgress({ status }: { status: NonNullable<ReturnType<typeof useCommandStatus>["data"]> }) {
  const failedResults = status.dispatches.flatMap((dispatch) =>
    dispatch.results.filter((result) => result.status === "failed" || result.status === "timed_out")
  );
  const isFailure = status.stage === "partial_failed" || status.stage === "failed" || status.stage === "timed_out";
  return (
    <div className="dial-card" aria-live="polite">
      <span>최근 명령 상태</span>
      <strong>{commandStageLabel(status.stage)}</strong>
      <small>{status.completedFixtureCount} / {status.totalFixtureCount} 처리</small>
      {failedResults.map((result) => (
        <small className={isFailure ? "danger-text" : ""} key={result.fixtureId}>
          {result.fixtureName}: {result.errorMessage ?? (result.status === "timed_out" ? "응답 시간 초과" : "적용 실패")}
        </small>
      ))}
    </div>
  );
}

function commandStageLabel(stage: CommandStage) {
  const labels: Record<CommandStage, string> = {
    queued: "명령 접수 완료",
    published: "게이트웨이 전송 완료",
    accepted: "게이트웨이 수신 완료",
    completed: "조명 적용 완료",
    partial_failed: "일부 조명 적용 실패",
    failed: "명령 처리 실패",
    timed_out: "명령 응답 시간 초과"
  };
  return labels[stage];
}

function formatControlBlockReason(
  reason: "fixture_unmapped" | "gateway_offline" | "fixture_fault" | "fixture_offline" | null,
  fixtureName: string
) {
  const detail = reason === "fixture_unmapped"
    ? "게이트웨이에 매핑되지 않았습니다."
    : reason === "gateway_offline"
      ? "게이트웨이가 오프라인입니다."
      : reason === "fixture_fault"
        ? "조명 장애를 먼저 점검해야 합니다."
        : reason === "fixture_offline"
          ? "조명이 오프라인입니다."
          : "현재 제어할 수 없습니다.";
  return `${fixtureName}: ${detail}`;
}
