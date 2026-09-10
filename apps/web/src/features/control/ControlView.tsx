import { CircleCheck, Clock3, Eye, Layers3, TriangleAlert } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CreateDimmingCommandInput } from "@led-control/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import type { AuthUser } from "../../api/auth";
import { Button, Card, PageHeader, ProgressSteps, SidePanel, StatusBadge, type ProgressStep, type ProgressStepState } from "../../components/ui";
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
import {
  ControlTargetPicker,
  controlSelectionToDimmingTarget,
  type ControlSelection
} from "./ControlTargetPicker";
import { humanizeDeviceResponseMessage } from "./control-copy";
import { FixtureGroupDialog } from "./FixtureGroupDialog";
import { ControlModeTabs, type ControlPageMode } from "./automation/ControlModeTabs";
import { floorMeshReadiness } from "./control-readiness";
import {
  isActiveCommandSessionBlocked,
  ownsActiveCommandSession,
  registerActiveCommandRequest
} from "./active-command-session";

const ScheduleControlPanel = lazy(async () => {
  const module = await import("./automation/ScheduleControlPanel");
  return { default: module.ScheduleControlPanel };
});

const VehicleEventControlPanel = lazy(async () => {
  const module = await import("./automation/VehicleEventControlPanel");
  return { default: module.VehicleEventControlPanel };
});

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
  const location = useLocation();
  const navigate = useNavigate();
  const requestedMode = new URLSearchParams(location.search).get("mode");
  const { data, isLoading, error } = useControlDashboard(siteId);
  const capabilities = data?.capabilities;
  const canControl = capabilities?.control === true;
  const canManage = capabilities?.manage === true;
  const mode: ControlPageMode = isControlPageMode(requestedMode)
    && (requestedMode === "manual" || canManage)
    ? requestedMode
    : "manual";
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<ControlSelection>(emptySelection);
  const [brightness, setBrightness] = useState(70);
  const [overrideUntilLocal, setOverrideUntilLocal] = useState(() => defaultOverrideUntilLocal());
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
  const readOnly = !canControl;
  const target = selected.isValid ? controlSelectionToDimmingTarget(selection) : null;
  const commandInProgress = Boolean(
    scopedActiveRequest && !scopedCommandId
    || scopedCommandId && !matchingCommandIsTerminal
  );
  const restorePending = Boolean(
    activeSiteId && (activeSiteId !== commandSiteId || userId !== commandUserId)
  );
  const controlsLocked = readOnly || commandSessionBlocked || isSubmitting || restorePending || commandInProgress;
  const canSubmit = Boolean(data && target && selected.fixtures.length > 0 && !blockMessage && !controlsLocked);

  useEffect(() => {
    if (!capabilities) return;
    if (requestedMode === mode) return;
    const search = new URLSearchParams(location.search);
    search.set("mode", mode);
    void navigate({ pathname: location.pathname, search: `?${search.toString()}` }, { replace: true });
  }, [capabilities, location.pathname, location.search, mode, navigate, requestedMode]);

  useEffect(() => {
    if (mode !== "manual") setGroupDialogOpen(false);
  }, [mode]);

  useLayoutEffect(() => {
    const generation = ++requestGeneration.current;
    activePostController.current?.abort();
    activePostController.current = null;
    activeScope.current = { generation, userId, siteId: activeSiteId };
    setIsSubmitting(false);
    setSelection(emptySelection);
    setOverrideUntilLocal(defaultOverrideUntilLocal());
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

    const overrideUntil = overrideUntilFromLocal(overrideUntilLocal);
    const overrideValidationError = validateOverrideUntil(overrideUntil);
    if (overrideValidationError) {
      setMessage(overrideValidationError);
      return;
    }

    const request = canonicalizeDimmingCommandInput({
      siteId: data.site.id,
      clientRequestId: crypto.randomUUID(),
      target,
      brightness,
      ...(overrideUntil ? { overrideUntil } : {})
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
      setMessage("명령을 전송했습니다. 장비 응답을 기다리는 중입니다.");
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

  function selectMode(nextMode: ControlPageMode) {
    const search = new URLSearchParams(location.search);
    search.set("mode", nextMode);
    void navigate({ pathname: location.pathname, search: `?${search.toString()}` });
  }

  const modeTabs = <ControlModeTabs mode={mode} onChange={selectMode} allowAutomation={canManage} />;
  const pageHeader = (
    <PageHeader
      title="조명 제어"
      description="수동 명령과 Gateway 자동화 규칙을 한곳에서 관리합니다."
    />
  );

  if (capabilities && mode === "event") {
    const eventSiteId = data?.site.id ?? siteId;
    return (
      <section className="control-screen">
        {pageHeader}
        {modeTabs}
        {eventSiteId ? (
          <Suspense fallback={<p className="muted-text" role="status">이벤트 화면을 불러오는 중입니다.</p>}>
            <VehicleEventControlPanel key={`${userId}:${eventSiteId}`} siteId={eventSiteId} role={userRole} dashboard={data} scopeKey={`${userId}:${eventSiteId}`} />
          </Suspense>
        ) : isLoading ? <p className="muted-text" role="status">현장 정보를 불러오는 중입니다.</p> : <p className="danger-text" role="alert">이벤트 현장을 확인하지 못했습니다.</p>}
      </section>
    );
  }

  if (capabilities && mode === "schedule") {
    const scheduleSiteId = data?.site.id ?? siteId;
    return (
      <section className="control-screen">
        {pageHeader}
        {modeTabs}
        {scheduleSiteId ? (
          <Suspense
            fallback={(
              <div
                id="control-mode-panel-schedule"
                role="tabpanel"
                aria-labelledby="control-mode-schedule"
              >
                <p className="muted-text" role="status">스케줄 화면을 불러오는 중입니다.</p>
              </div>
            )}
          >
            <ScheduleControlPanel
              key={`${userId}:${scheduleSiteId}`}
              siteId={scheduleSiteId}
              role={userRole}
              dashboard={data}
              scopeKey={`${userId}:${scheduleSiteId}`}
            />
          </Suspense>
        ) : isLoading ? (
          <p className="muted-text" role="status">현장 정보를 불러오는 중입니다.</p>
        ) : (
          <p className="danger-text" role="alert">스케줄 현장을 확인하지 못했습니다.</p>
        )}
      </section>
    );
  }

  if (isLoading && !data) {
    return <section className="control-screen">{pageHeader}{modeTabs}<p className="muted-text" role="status">제어 대상을 불러오는 중입니다.</p></section>;
  }

  if (error && !data) {
    return <section className="control-screen">{pageHeader}{modeTabs}<p className="danger-text" role="alert">제어 대상을 불러오지 못했습니다.</p></section>;
  }

  if (!data) {
    return <section className="control-screen">{pageHeader}{modeTabs}<p className="muted-text" role="status">제어 대상 데이터가 없습니다.</p></section>;
  }

  return (
    <section className="control-screen">
      {pageHeader}
      {modeTabs}
      <div id="control-mode-panel-manual" role="tabpanel" aria-labelledby="control-mode-manual" className="control-manual-panel">
      <PageHeader
        title="조명 밝기 제어"
        headingLevel={3}
        description="제어 대상을 선택한 뒤 밝기와 수동 override 시간을 적용합니다."
        actions={(
          <Button
            ref={groupDialogOpenerRef}
            variant="secondary"
            className="control-group-button"
            type="button"
            onClick={() => setGroupDialogOpen(true)}
            disabled={commandSessionBlocked || isSubmitting || restorePending || commandInProgress}
          >
            <Layers3 size={16} aria-hidden="true" /> {canManage ? "구역 관리" : "구역 현황"}
          </Button>
        )}
      />

      {readOnly ? (
        <p className="danger-text control-readonly-notice" role="alert">
          조회 전용 계정입니다. 조명 제어는 제어 권한이 있는 계정만 사용할 수 있습니다.
        </p>
      ) : null}

      <div className="control-layout ui-side-panel-layout">
        <Card className="control-target-card" aria-label="제어 대상 선택">
          <fieldset className="control-picker-fieldset" aria-label="제어 대상 선택" disabled={controlsLocked}>
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
        </Card>

        <SidePanel className="control-panel" aria-label="밝기 실행">
          <div className="panel-title-row">
            <div>
              <span className="eyebrow">선택 대상</span>
              <h3>{selected.name}</h3>
            </div>
            <ManualControlBadge readOnly={readOnly} canSubmit={canSubmit} blocked={Boolean(blockMessage)} />
          </div>

          <div className="control-panel-body">
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
                <Button key={value} variant="secondary" type="button" onClick={() => setBrightness(value)} disabled={controlsLocked}>
                  {value}%
                </Button>
              ))}
            </div>

            <label className="form-field control-override-field">
              <span>수동 override 종료 시각</span>
              <input
                type="datetime-local"
                aria-label="수동 override 종료 시각"
                value={overrideUntilLocal}
                disabled={controlsLocked}
                onChange={(event) => {
                  setOverrideUntilLocal(event.target.value);
                  setMessage("");
                }}
              />
              <small>비워두면 서버 기본값을 사용합니다.</small>
            </label>

            <Button variant="primary" type="button" onClick={submitCommand} disabled={!canSubmit}>
              {commandSessionBlocked ? "로그아웃 중" : controlsLocked && !readOnly ? "밝기 적용 중" : "밝기 적용"}
            </Button>
          </div>
          <div className="control-panel-feedback">
            <div className="command-status-region" role="status" aria-label="명령 진행 상태" aria-live="polite">
              {scopedActiveRequest && !scopedCommandId ? (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => void sendCommand(scopedActiveRequest, userId)}
                  disabled={isSubmitting || commandSessionBlocked}
                >
                  동일 요청 다시 전송
                </Button>
              ) : null}
              {message ? <p className={message.startsWith("명령을 전송") ? "success-text" : "danger-text"}>{message}</p> : null}
              {matchingCommandStatus ? <CommandProgress status={matchingCommandStatus} /> : null}
              {!matchingCommandStatus && terminalResult?.siteId === data.site.id ? <CommandProgress status={terminalResult.status} /> : null}
            </div>
            {blockMessage ? <p className="danger-text" role="alert">{blockMessage}</p> : null}
            {hasMismatchedCommandStatus && !missingCommand ? (
              <div className="command-status-error" role="alert">
                <p className="danger-text">
                  명령 상태 응답의 식별자가 일치하지 않습니다. 안전을 위해 제어 잠금을 유지합니다.
                </p>
                <Button variant="secondary" type="button" onClick={() => void commandQuery.refetch()} disabled={commandQuery.isFetching}>
                  {commandQuery.isFetching ? "명령 상태 조회 중" : "명령 상태 다시 조회"}
                </Button>
              </div>
            ) : null}
            {commandQuery.error && scopedCommandId && !missingCommand && !matchingCommandIsTerminal && !hasMismatchedCommandStatus ? (
              <div className="command-status-error" role="alert">
                <p className="danger-text">명령 상태를 불러오지 못했습니다. 연결을 확인한 뒤 다시 조회하세요.</p>
                <Button variant="secondary" type="button" onClick={() => void commandQuery.refetch()} disabled={commandQuery.isFetching}>
                  {commandQuery.isFetching ? "명령 상태 조회 중" : "명령 상태 다시 조회"}
                </Button>
              </div>
            ) : null}
          </div>
        </SidePanel>
      </div>
      <FixtureGroupDialog
        open={groupDialogOpen}
        siteId={data.site.id}
        dashboard={data}
        canManage={canManage}
        returnFocusRef={groupDialogOpenerRef}
        onClose={() => setGroupDialogOpen(false)}
      />
      </div>
    </section>
  );
}

function ManualControlBadge({ readOnly, canSubmit, blocked }: { readOnly: boolean; canSubmit: boolean; blocked: boolean }) {
  if (readOnly) return <StatusBadge tone="neutral" icon={Eye}>조회 전용</StatusBadge>;
  if (canSubmit) return <StatusBadge tone="success" icon={CircleCheck}>전송 가능</StatusBadge>;
  if (blocked) return <StatusBadge tone="danger" icon={TriangleAlert}>제어 불가</StatusBadge>;
  return <StatusBadge tone="neutral" icon={Clock3}>대상 없음</StatusBadge>;
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

function deliveryLabel(selection: ControlSelection, fixtureCount: number) {
  if (selection.mode === "floor" || selection.mode === "group") return "BLE Mesh 그룹 전송";
  if (fixtureCount === 1) return "BLE Mesh 개별 전송";
  if (fixtureCount > 1) return "BLE Mesh 다중 대상 전송";
  return "대상을 선택하세요";
}

function isControlPageMode(value: string | null): value is ControlPageMode {
  return value === "manual" || value === "schedule" || value === "event";
}

function CommandProgress({ status }: { status: NonNullable<ReturnType<typeof useCommandStatus>["data"]> }) {
  const failedResults = status.dispatches.flatMap((dispatch) =>
    dispatch.results.filter((result) => result.status === "failed" || result.status === "timed_out")
  );
  const isFailure = status.stage === "partial_failed" || status.stage === "failed" || status.stage === "timed_out";
  return (
    <div className="command-progress-card">
      <span>최근 명령 상태</span>
      <strong>{commandStageLabel(status.stage)}</strong>
      <small>{status.completedFixtureCount} / {status.totalFixtureCount} 처리</small>
      <ProgressSteps label="명령 진행" steps={commandSteps(status.stage)} />
      {failedResults.map((result) => (
        <small className={isFailure ? "danger-text" : ""} key={result.fixtureId}>
          {result.fixtureName}: {humanizeDeviceResponseMessage(result.errorMessage ?? (result.status === "timed_out" ? "응답 시간 초과" : "적용 실패"))}
        </small>
      ))}
    </div>
  );
}

function commandSteps(stage: CommandStage): ProgressStep[] {
  return [
    { id: "queued", label: "명령 접수", state: stepState(stage, "queued") },
    { id: "published", label: "Gateway 전송", state: stepState(stage, "published") },
    { id: "accepted", label: "장비 응답", state: stepState(stage, "accepted") },
    { id: "completed", label: "조명 적용", state: terminalStepState(stage) }
  ];
}

function stepState(stage: CommandStage, step: "queued" | "published" | "accepted"): ProgressStepState {
  const stageRank: Record<"queued" | "published" | "accepted", number> = { queued: 0, published: 1, accepted: 2 };
  const currentRank = stage === "completed" || stage === "partial_failed" || stage === "failed" || stage === "timed_out"
    ? 3
    : stageRank[stage];
  const stepRank = stageRank[step];
  if (currentRank > stepRank) return "complete";
  if (currentRank === stepRank) return "current";
  return "pending";
}

function terminalStepState(stage: CommandStage): ProgressStepState {
  if (stage === "completed") return "complete";
  if (stage === "partial_failed" || stage === "failed" || stage === "timed_out") return "error";
  return "pending";
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

function defaultOverrideUntilLocal(now = new Date()) {
  const date = new Date(now.getTime() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-") + `T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function overrideUntilFromLocal(value: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function validateOverrideUntil(overrideUntil: string | null | undefined, now = new Date()) {
  if (overrideUntil === undefined) return null;
  if (overrideUntil === null) return "종료 시각을 확인해 주세요.";
  const until = Date.parse(overrideUntil);
  if (until <= now.getTime()) return "종료 시각은 현재 이후여야 합니다.";
  if (until > now.getTime() + 30 * 24 * 60 * 60 * 1000) return "종료 시각은 30일 이내여야 합니다.";
  return null;
}
