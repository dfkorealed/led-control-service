import { Layers3 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CreateDimmingCommandInput, DimmingTarget } from "@led-control/shared";
import { useQueryClient } from "@tanstack/react-query";
import type { AuthUser } from "../../api/auth";
import {
  canonicalizeDimmingCommandInput,
  createDimmingCommand,
  isTerminalCommandStage,
  useCommandStatus,
  type CommandStage,
  type CommandStatusResponse
} from "../../api/commands";
import { useControlDashboard, type DashboardFixture } from "../../api/queries";
import {
  clearActiveCommandId,
  clearActiveCommandRequest,
  loadActiveCommandId,
  loadActiveCommandRequest,
  saveActiveCommandId,
  saveActiveCommandRequest
} from "./active-command-store";
import { ControlTargetPicker, type ControlSelection } from "./ControlTargetPicker";
import { FixtureGroupDialog } from "./FixtureGroupDialog";
import { floorMeshReadiness } from "./control-readiness";
import {
  isActiveCommandSessionBlocked,
  ownsActiveCommandSession,
  registerActiveCommandRequest
} from "./active-command-session";

const emptySelection: ControlSelection = { mode: "fixtures", fixtureIds: [] };

export function ControlView({
  siteId,
  userId,
  userRole,
  commandSessionBlocked = false
}: {
  siteId?: string;
  userId: AuthUser["id"];
  userRole: AuthUser["role"];
  commandSessionBlocked?: boolean;
}) {
  const { data, isLoading, error } = useControlDashboard(siteId);
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<ControlSelection>(emptySelection);
  const [brightness, setBrightness] = useState(70);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [commandId, setCommandId] = useState<string | null>(null);
  const [commandSiteId, setCommandSiteId] = useState<string | null>(null);
  const [commandUserId, setCommandUserId] = useState<string | null>(null);
  const [activeRequest, setActiveRequest] = useState<CreateDimmingCommandInput | null>(null);
  const [terminalResult, setTerminalResult] = useState<{ siteId: string; status: CommandStatusResponse } | null>(null);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const groupDialogOpenerRef = useRef<HTMLButtonElement>(null);
  const requestGeneration = useRef(0);
  const activePostController = useRef<AbortController | null>(null);
  const activeScope = useRef<{ generation: number; userId: string; siteId: string | null }>({
    generation: 0,
    userId,
    siteId: null
  });
  const activeSiteId = data?.site.id ?? null;
  const commandScopeMatches = Boolean(
    activeSiteId && commandUserId === userId && commandSiteId === activeSiteId
  );
  const scopedCommandId = commandScopeMatches ? commandId : null;
  const scopedActiveRequest = commandScopeMatches && activeRequest?.siteId === activeSiteId ? activeRequest : null;
  const commandQuery = useCommandStatus(scopedCommandId);
  const matchingCommandStatus = commandQuery.data?.id === scopedCommandId ? commandQuery.data : null;
  const matchingCommandIsTerminal = isTerminalCommandStage(matchingCommandStatus?.stage);
  const hasMismatchedCommandStatus = Boolean(
    scopedCommandId && commandQuery.data && commandQuery.data.id !== scopedCommandId
  );
  const missingCommand = isMissingCommandError(commandQuery.error);
  const fixtures = useMemo(() => data?.floors.flatMap((floor) => floor.fixtures) ?? [], [data]);
  const selected = useMemo(() => resolveSelection(data, fixtures, selection), [data, fixtures, selection]);
  const blockedFixture = selected.fixtures.find((fixture) => !fixture.controllable);
  const blockMessage = blockedFixture
    ? formatControlBlockReason(blockedFixture.controlBlockReason, blockedFixture.name)
    : null;
  const readOnly = userRole === "viewer";
  const target = selected.isValid ? toDimmingTarget(selection) : null;
  const commandInProgress = Boolean(
    scopedActiveRequest && !scopedCommandId
    || scopedCommandId && !matchingCommandIsTerminal
  );
  const restorePending = Boolean(
    activeSiteId && (activeSiteId !== commandSiteId || userId !== commandUserId)
  );
  const controlsLocked = readOnly || commandSessionBlocked || isSubmitting || restorePending || commandInProgress;
  const canSubmit = Boolean(data && target && selected.fixtures.length > 0 && !blockMessage && !controlsLocked);

  useLayoutEffect(() => {
    const generation = ++requestGeneration.current;
    activePostController.current?.abort();
    activePostController.current = null;
    activeScope.current = { generation, userId, siteId: activeSiteId };
    setIsSubmitting(false);
    setSelection(emptySelection);
    setMessage("");
    setTerminalResult(null);
    setGroupDialogOpen(false);
    setCommandUserId(userId);
    setCommandSiteId(activeSiteId);
    setActiveRequest(activeSiteId ? loadActiveCommandRequest(userId, activeSiteId) : null);
    setCommandId(activeSiteId ? loadActiveCommandId(userId, activeSiteId) : null);

    return () => {
      if (activeScope.current.generation === generation) {
        requestGeneration.current += 1;
        activeScope.current = { generation: requestGeneration.current, userId, siteId: null };
      }
      activePostController.current?.abort();
      activePostController.current = null;
    };
  }, [activeSiteId, userId]);

  useEffect(() => {
    if (!activeSiteId || !scopedCommandId || !matchingCommandStatus || !matchingCommandIsTerminal) return;

    setTerminalResult({ siteId: activeSiteId, status: matchingCommandStatus });
    clearActiveCommandId(userId, activeSiteId, scopedCommandId);
    setActiveRequest(null);
    setCommandId((currentCommandId) => currentCommandId === scopedCommandId ? null : currentCommandId);
    setMessage("");
  }, [activeSiteId, matchingCommandIsTerminal, matchingCommandStatus, scopedCommandId, userId]);

  useEffect(() => {
    if (!activeSiteId || !scopedCommandId || matchingCommandIsTerminal || !missingCommand) return;

    clearActiveCommandId(userId, activeSiteId, scopedCommandId);
    setActiveRequest(null);
    setCommandId((currentCommandId) => currentCommandId === scopedCommandId ? null : currentCommandId);
    setMessage("진행 중 명령을 찾을 수 없어 제어 잠금을 해제했습니다");
  }, [activeSiteId, matchingCommandIsTerminal, missingCommand, scopedCommandId, userId]);

  async function submitCommand() {
    if (!data || !target || !canSubmit || isActiveCommandSessionBlocked(userId)) return;

    const request = canonicalizeDimmingCommandInput({
      siteId: data.site.id,
      clientRequestId: crypto.randomUUID(),
      target,
      brightness
    });
    saveActiveCommandRequest(userId, data.site.id, request);
    setCommandUserId(userId);
    setCommandSiteId(data.site.id);
    setActiveRequest(request);
    setTerminalResult(null);
    await sendCommand(request, userId);
  }

  async function sendCommand(request: CreateDimmingCommandInput, requestUserId: string) {
    const generation = activeScope.current.generation;
    const controller = new AbortController();
    const commandSession = registerActiveCommandRequest(requestUserId, controller);
    if (!commandSession) return;
    activePostController.current?.abort();
    activePostController.current = controller;
    setIsSubmitting(true);
    setMessage("");
    try {
      const command = await createDimmingCommand(request, controller.signal);
      if (
        !ownsRequestScope(generation, requestUserId, request.siteId)
        || !ownsActiveCommandSession(requestUserId, commandSession.generation)
      ) return;
      saveActiveCommandId(requestUserId, request.siteId, command.id);
      setCommandUserId(requestUserId);
      setCommandSiteId(request.siteId);
      setCommandId(command.id);
      setMessage("명령을 전송했습니다. 장비 ACK를 기다리는 중입니다.");
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (error) {
      if (
        !ownsRequestScope(generation, requestUserId, request.siteId)
        || !ownsActiveCommandSession(requestUserId, commandSession.generation)
      ) return;
      if (isDefinitiveCommandRejection(error)) {
        clearActiveCommandRequest(requestUserId, request.siteId, request.clientRequestId);
        setActiveRequest(null);
        setCommandId(null);
        setMessage(definitiveRejectionMessage(error));
      } else {
        setMessage("명령 응답을 확인하지 못했습니다. 동일 요청으로 다시 전송하세요.");
      }
    } finally {
      commandSession.release();
      if (activePostController.current === controller) activePostController.current = null;
      if (ownsRequestScope(generation, requestUserId, request.siteId)) setIsSubmitting(false);
    }
  }

  function ownsRequestScope(generation: number, requestUserId: string, requestSiteId: string) {
    return activeScope.current.generation === generation
      && activeScope.current.userId === requestUserId
      && activeScope.current.siteId === requestSiteId;
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
        <button
          ref={groupDialogOpenerRef}
          className="secondary-button"
          type="button"
          onClick={() => setGroupDialogOpen(true)}
          disabled={commandSessionBlocked || isSubmitting || restorePending || commandInProgress}
        >
          <Layers3 size={16} aria-hidden="true" /> {readOnly ? "구역 현황" : "구역 관리"}
        </button>
      </div>

      {readOnly ? (
        <p className="danger-text control-readonly-notice" role="alert">
          조회 전용 계정입니다. 조명 제어는 operator 또는 admin 계정으로만 수행할 수 있습니다.
        </p>
      ) : null}

      <div className="control-layout">
        <fieldset className="control-picker-fieldset" disabled={controlsLocked}>
          <ControlTargetPicker
            key={data.site.id}
            dashboard={data}
            selection={selection}
            disabled={controlsLocked}
            onChange={(nextSelection) => {
              setSelection(nextSelection);
              if (nextSelection.mode === "fixtures" && nextSelection.fixtureIds.length === 1) {
                const fixture = fixtures.find((item) => item.id === nextSelection.fixtureIds[0]);
                if (fixture) setBrightness(fixture.brightness);
              }
              setMessage("");
            }}
          />
        </fieldset>

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
              disabled={controlsLocked}
              onChange={(event) => setBrightness(Number(event.target.value))}
            />
          </div>

          <div className="preset-row">
            {[0, 30, 70, 100].map((value) => (
              <button key={value} type="button" onClick={() => setBrightness(value)} disabled={controlsLocked}>
                {value}%
              </button>
            ))}
          </div>

          <button className="primary-button" type="button" onClick={submitCommand} disabled={!canSubmit}>
            {commandSessionBlocked ? "로그아웃 중" : controlsLocked && !readOnly ? "밝기 적용 중" : "밝기 적용"}
          </button>
          {scopedActiveRequest && !scopedCommandId ? (
            <button
              type="button"
              onClick={() => void sendCommand(scopedActiveRequest, userId)}
              disabled={isSubmitting || commandSessionBlocked}
            >
              동일 요청 다시 전송
            </button>
          ) : null}
          {blockMessage ? <p className="danger-text" role="alert">{blockMessage}</p> : null}
          {message ? <p className={message.startsWith("명령을 전송") ? "success-text" : "danger-text"}>{message}</p> : null}
          {matchingCommandStatus ? <CommandProgress status={matchingCommandStatus} /> : null}
          {!matchingCommandStatus && terminalResult?.siteId === data.site.id ? <CommandProgress status={terminalResult.status} /> : null}
          {hasMismatchedCommandStatus && !missingCommand ? (
            <div className="command-status-error" role="alert">
              <p className="danger-text">
                명령 상태 응답의 식별자가 일치하지 않습니다. 안전을 위해 제어 잠금을 유지합니다.
              </p>
              <button type="button" onClick={() => void commandQuery.refetch()} disabled={commandQuery.isFetching}>
                {commandQuery.isFetching ? "명령 상태 조회 중" : "명령 상태 다시 조회"}
              </button>
            </div>
          ) : null}
          {commandQuery.error && scopedCommandId && !missingCommand && !matchingCommandIsTerminal && !hasMismatchedCommandStatus ? (
            <div className="command-status-error" role="alert">
              <p className="danger-text">명령 상태를 불러오지 못했습니다. 연결을 확인한 뒤 다시 조회하세요.</p>
              <button type="button" onClick={() => void commandQuery.refetch()} disabled={commandQuery.isFetching}>
                {commandQuery.isFetching ? "명령 상태 조회 중" : "명령 상태 다시 조회"}
              </button>
            </div>
          ) : null}
        </aside>
      </div>
      <FixtureGroupDialog
        open={groupDialogOpen}
        siteId={data.site.id}
        dashboard={data}
        canManage={!readOnly}
        returnFocusRef={groupDialogOpenerRef}
        onClose={() => setGroupDialogOpen(false)}
      />
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
    return selectionResult(
      floor?.name ?? "층 선택",
      floor?.fixtures ?? [],
      Boolean(floor && floorMeshReadiness(floor).ready)
    );
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
    Boolean(
      group &&
      group.lifecycleStatus === "active" &&
      group.meshControlGroup?.status === "ready" &&
      group.fixtureIds.length > 0 &&
      groupFixtures.length === group.fixtureIds.length
    )
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

function isMissingCommandError(error: unknown): error is { status: number } {
  return Boolean(
    error
    && typeof error === "object"
    && "status" in error
    && (error as { status?: unknown }).status === 404
  );
}

function isDefinitiveCommandRejection(error: unknown): error is { status: number; body?: unknown } {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
}

function definitiveRejectionMessage(error: { status: number; body?: unknown }): string {
  if (error.status === 403) return "제어 권한이 없습니다. 권한을 확인한 뒤 다시 시도하세요.";
  if (error.status === 409) return "동일 요청 ID가 다른 제어 내용과 충돌했습니다. 새 제어 요청을 실행하세요.";
  return `제어 요청이 거부되었습니다(${error.status}). 입력과 권한을 확인하세요.`;
}
