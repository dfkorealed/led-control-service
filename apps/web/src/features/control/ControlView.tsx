import { CircleCheck, Clock3, Eye, Layers3, TriangleAlert } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CreateDimmingCommandInput } from "@led-control/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import type { AuthUser } from "../../api/auth";
import { Button, Card, Heading, NumberField, PageHeader, ProgressSteps, SidePanel, Slider, StatusBadge, Text, type ProgressStep, type ProgressStepState } from "../../components/ui";
import {
  canonicalizeDimmingCommandInput,
  createDimmingCommand,
  createCommandStatusCheck,
  isSettledCommandStatus,
  isTerminalCommandStage,
  useCommandStatus,
  type CommandStage,
  type CommandStatusResponse
} from "../../api/commands";
import { useControlDashboard } from "../../api/queries";
import {
  clearActiveCommandId,
  clearActiveCommandRequest,
  loadActiveCommandId,
  loadActiveCommandRequest,
  saveActiveCommandId,
  saveActiveCommandRequest
} from "./active-command-store";
import { controlSelectionToDimmingTarget, resolveControlSelection, type ControlSelection } from "./control-selection";
import { humanizeDeviceResponseMessage } from "./control-copy";
import { FixtureGroupDialog } from "./FixtureGroupDialog";
import { ControlModeTabs, type ControlPageMode } from "./automation/ControlModeTabs";
import { CommandHistoryPanel, COMMAND_STAGE_LABELS } from "./CommandHistoryPanel";
import { CommandOutcomeActions } from "./CommandOutcomeActions";
import {
  isActiveCommandSessionBlocked,
  ownsActiveCommandSession,
  registerActiveCommandRequest
} from "./active-command-session";
import { SpatialTargetSelector } from "./target-selection/SpatialTargetSelector";

const ScheduleControlPanel = lazy(async () => {
  const module = await import("./automation/ScheduleControlPanel");
  return { default: module.ScheduleControlPanel };
});

const VehicleEventControlPanel = lazy(async () => {
  const module = await import("./automation/VehicleEventControlPanel");
  return { default: module.VehicleEventControlPanel };
});

const emptySelection: ControlSelection = { mode: "fixtures", fixtureIds: [] };
const controlScreenClassName = "grid min-h-0 min-w-0 content-start gap-4 tablet:fixed tablet:top-16 tablet:right-6 tablet:bottom-6 tablet:left-16 tablet:mt-6 tablet:ml-16 tablet:flex tablet:flex-col tablet:overflow-hidden";

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
  const [message, setMessage] = useState("");
  const [verificationError, setVerificationError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [commandId, setCommandId] = useState<string | null>(null);
  const [commandSiteId, setCommandSiteId] = useState<string | null>(null);
  const [commandUserId, setCommandUserId] = useState<string | null>(null);
  const [activeRequest, setActiveRequest] = useState<CreateDimmingCommandInput | null>(null);
  const [terminalResult, setTerminalResult] = useState<{ siteId: string; status: CommandStatusResponse } | null>(null);
  const [verificationRequest, setVerificationRequest] = useState<{
    commandId: string; clientRequestId: string; dispatchIds?: string[]; responseLost?: boolean;
  } | null>(null);
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
  const statusArguments: [string | null, string[]?, boolean?] = verificationRequest
    ? [scopedCommandId, verificationRequest.dispatchIds, true] : [scopedCommandId];
  const commandQuery = useCommandStatus(...statusArguments);
  const matchingCommandStatus = commandQuery.data?.id === scopedCommandId ? commandQuery.data : null;
  const waitingForVerification = Boolean(verificationRequest && (!verificationRequest.dispatchIds
    || verificationRequest.dispatchIds.some((id) => !matchingCommandStatus?.dispatches.some((dispatch) => dispatch.id === id))));
  // A conclusive device result can arrive even when the status-check POST reply
  // was lost. It must release the lock without requiring that missing reply.
  const matchingCommandIsTerminal = isSettledCommandStatus(matchingCommandStatus)
    && (!waitingForVerification || matchingCommandStatus?.stage !== "verification_required");
  const displayedStatus = matchingCommandStatus ?? (commandScopeMatches && terminalResult?.siteId === activeSiteId ? terminalResult.status : null);
  const hasMismatchedCommandStatus = Boolean(
    scopedCommandId && commandQuery.data && commandQuery.data.id !== scopedCommandId
  );
  const missingCommand = isMissingCommandError(commandQuery.error);
  const resolvedSelection = useMemo(
    () => data ? resolveControlSelection(data, selection) : null,
    [data, selection]
  );
  const selectedFixtures = resolvedSelection?.fixtures ?? [];
  const selectedName = selectionName(data, selection, selectedFixtures.length);
  const blockMessage = resolvedSelection?.unavailableReason ?? null;
  const readOnly = !canControl;
  const target = resolvedSelection?.available ? controlSelectionToDimmingTarget(selection) : null;
  const commandInProgress = Boolean(
    scopedActiveRequest && !scopedCommandId
    || scopedCommandId && !matchingCommandIsTerminal
    || verificationRequest
  );
  const restorePending = Boolean(
    activeSiteId && (activeSiteId !== commandSiteId || userId !== commandUserId)
  );
  const controlsLocked = readOnly || commandSessionBlocked || isSubmitting || restorePending || commandInProgress;
  const canSubmit = Boolean(data && target && resolvedSelection?.fixtureIds.length && !blockMessage && !controlsLocked);

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
    setMessage("");
    setVerificationError("");
    setTerminalResult(null);
    setVerificationRequest(null);
    setGroupDialogOpen(false);
    setCommandUserId(userId);
    setCommandSiteId(activeSiteId);
    setActiveRequest(activeSiteId ? loadActiveCommandRequest(userId, activeSiteId) : null);
    const restoredCommandId = activeSiteId ? loadActiveCommandId(userId, activeSiteId) : null;
    // A saved identity may have gained a status-check while this view was gone.
    // Discard its old terminal cache before enabling the restored detail query.
    if (restoredCommandId) queryClient.removeQueries({ queryKey: ["command-status", restoredCommandId], exact: true });
    setCommandId(restoredCommandId);

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
    if (!activeSiteId || !scopedCommandId || !matchingCommandStatus || !matchingCommandIsTerminal || isSubmitting) return;

    setTerminalResult({ siteId: activeSiteId, status: matchingCommandStatus });
    clearActiveCommandId(userId, activeSiteId, scopedCommandId);
    setActiveRequest(null);
    setVerificationRequest(null);
    setCommandId((currentCommandId) => currentCommandId === scopedCommandId ? null : currentCommandId);
    setMessage("");
    void queryClient.invalidateQueries({ queryKey: ["command-history", userId] });
  }, [activeSiteId, isSubmitting, matchingCommandIsTerminal, matchingCommandStatus, queryClient, scopedCommandId, userId]);

  useEffect(() => {
    if (!activeSiteId || !scopedCommandId || matchingCommandIsTerminal || !missingCommand) return;

    clearActiveCommandId(userId, activeSiteId, scopedCommandId);
    setActiveRequest(null);
    setVerificationRequest(null);
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

  function openHistoricalCommand(id: string) {
    if (!activeSiteId || commandInProgress || isSubmitting || restorePending || commandSessionBlocked) return;
    setTerminalResult(null);
    setMessage("");
    setVerificationError("");
    // Historical recovery must be based on a fresh read; a cached not-applied
    // outcome can already have converged after a late device response.
    queryClient.removeQueries({ queryKey: ["command-status", id], exact: true });
    setCommandId(id);
    // Persist only the selected identity; detail decides whether it is still active.
    saveActiveCommandId(userId, activeSiteId, id);
  }

  async function safelyReapply() {
    if (!displayedStatus || displayedStatus.stage !== "verified_not_applied" || controlsLocked
      || !activeSiteId || isActiveCommandSessionBlocked(userId)) return;
    const { targetFixtureIds, brightness: originalBrightness } = displayedStatus;
    if (displayedStatus.siteId !== activeSiteId || !targetFixtureIds?.length || originalBrightness == null) {
      setMessage("원래 제어 대상과 밝기를 확인하지 못했습니다. 명령 상세를 다시 조회하세요.");
      return;
    }
    // A floor/group may have changed membership since the original command. Use
    // its persisted fixture snapshot, never the current picker or group members.
    const request = canonicalizeDimmingCommandInput({ siteId: activeSiteId, clientRequestId: crypto.randomUUID(),
      target: { type: "fixtures", fixtureIds: [...targetFixtureIds] }, brightness: originalBrightness });
    saveActiveCommandRequest(userId, activeSiteId, request);
    setActiveRequest(request);
    setTerminalResult(null);
    await sendCommand(request, userId);
  }

  async function checkActualState() {
    if (!displayedStatus || displayedStatus.stage !== "verification_required" || readOnly || isSubmitting
      || commandSessionBlocked || restorePending || !activeSiteId || isActiveCommandSessionBlocked(userId)) return;
    if (!verificationRequest && (displayedStatus.verificationAttemptCount ?? 0) >= 3) return;
    const request = verificationRequest ?? { commandId: displayedStatus.id, clientRequestId: crypto.randomUUID() };
    const requestSiteId = activeSiteId;
    const generation = activeScope.current.generation;
    const controller = new AbortController();
    const commandSession = registerActiveCommandRequest(userId, controller);
    if (!commandSession) return;
    activePostController.current?.abort();
    activePostController.current = controller;
    setVerificationRequest(request);
    setCommandId(request.commandId);
    saveActiveCommandId(userId, requestSiteId, request.commandId);
    const preserveInterruptedRequest = () => {
      if (!ownsRequestScope(generation, userId, requestSiteId) || activePostController.current !== controller) return;
      // Logout invalidates the session before aborting transport. Preserve only
      // the existing logical request for a possible failed-logout recovery; a
      // late transport callback must still fail the session-generation checks.
      setVerificationRequest((current) => current?.clientRequestId === request.clientRequestId
        ? { ...current, responseLost: true }
        : current);
      setIsSubmitting(false);
    };
    controller.signal.addEventListener("abort", preserveInterruptedRequest, { once: true });
    setIsSubmitting(true);
    setMessage("");
    setVerificationError("");
    try {
      const response = await createCommandStatusCheck(request.commandId, request.clientRequestId, controller.signal);
      if (!ownsRequestScope(generation, userId, requestSiteId) || !ownsActiveCommandSession(userId, commandSession.generation)) return;
      setVerificationRequest({ ...request, responseLost: false, dispatchIds: response.dispatchIds });
      setMessage("실제 밝기를 확인하고 있습니다.");
      await queryClient.invalidateQueries({ queryKey: ["command-status", request.commandId] });
    } catch (error) {
      if (!ownsRequestScope(generation, userId, requestSiteId) || !ownsActiveCommandSession(userId, commandSession.generation)) return;
      if (isDefinitiveCommandRejection(error)) {
        setVerificationRequest(null);
        setVerificationError(error.status === 403 ? "상태 확인 권한이 없습니다." : "상태 확인 요청이 거부되었습니다. 명령 상세를 다시 조회하세요.");
        await queryClient.invalidateQueries({ queryKey: ["command-status", request.commandId] });
      } else {
        setVerificationRequest({ ...request, responseLost: true });
        setMessage("상태 확인 응답을 받지 못했습니다. 동일 상태 확인 요청을 조회하세요.");
      }
    } finally {
      controller.signal.removeEventListener("abort", preserveInterruptedRequest);
      commandSession.release();
      // An aborted transport can finish after the same request has been resumed.
      // Its cleanup must not unlock or detach the replacement HTTP request.
      if (activePostController.current === controller) {
        activePostController.current = null;
        if (ownsRequestScope(generation, userId, requestSiteId)) setIsSubmitting(false);
      }
    }
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
    setVerificationError("");
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
        setMessage("명령 응답을 확인하지 못했습니다. 동일 요청 확인은 새 제어를 만들지 않습니다.");
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

  if (capabilities && mode === "event") {
    const eventSiteId = data?.site.id ?? siteId;
    return (
      <section className={controlScreenClassName} data-control-screen="">
        {modeTabs}
        {eventSiteId ? (
          <Suspense fallback={<Text tone="muted" role="status">이벤트 화면을 불러오는 중입니다.</Text>}>
            <VehicleEventControlPanel key={`${userId}:${eventSiteId}`} siteId={eventSiteId} role={userRole} dashboard={data} scopeKey={`${userId}:${eventSiteId}`} />
          </Suspense>
        ) : isLoading ? <Text tone="muted" role="status">현장 정보를 불러오는 중입니다.</Text> : <Text tone="danger" role="alert">이벤트 현장을 확인하지 못했습니다.</Text>}
      </section>
    );
  }

  if (capabilities && mode === "schedule") {
    const scheduleSiteId = data?.site.id ?? siteId;
    return (
      <section className={controlScreenClassName} data-control-screen="">
        {modeTabs}
        {scheduleSiteId ? (
          <Suspense
            fallback={(
              <div
                id="control-mode-panel-schedule"
                role="tabpanel"
                aria-labelledby="control-mode-schedule"
              >
                <Text tone="muted" role="status">스케줄 화면을 불러오는 중입니다.</Text>
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
          <Text tone="muted" role="status">현장 정보를 불러오는 중입니다.</Text>
        ) : (
          <Text tone="danger" role="alert">스케줄 현장을 확인하지 못했습니다.</Text>
        )}
      </section>
    );
  }

  if (isLoading && !data) {
    return <section className={controlScreenClassName} data-control-screen="">{modeTabs}<Text tone="muted" role="status">제어 대상을 불러오는 중입니다.</Text></section>;
  }

  if (error && !data) {
    return <section className={controlScreenClassName} data-control-screen="">{modeTabs}<Text tone="danger" role="alert">제어 대상을 불러오지 못했습니다.</Text></section>;
  }

  if (!data) {
    return <section className={controlScreenClassName} data-control-screen="">{modeTabs}<Text tone="muted" role="status">제어 대상 데이터가 없습니다.</Text></section>;
  }

  return (
    <section className={controlScreenClassName} data-control-screen="">
      {modeTabs}
      <div id="control-mode-panel-manual" role="tabpanel" aria-labelledby="control-mode-manual" className="grid min-h-0 min-w-0 gap-4 tablet:flex tablet:flex-1 tablet:flex-col" data-control-manual-panel="">
      <PageHeader
        title="조명 밝기 제어"
        headingLevel={3}
        description="제어 대상을 선택한 뒤 밝기를 적용합니다."
        actions={(
          <Button
            ref={groupDialogOpenerRef}
            variant="secondary"
            type="button"
            onClick={() => setGroupDialogOpen(true)}
            disabled={commandSessionBlocked || isSubmitting || restorePending || commandInProgress}
          >
            <Layers3 size={16} aria-hidden="true" /> {canManage ? "구역 관리" : "구역 현황"}
          </Button>
        )}
      />

      {readOnly ? (
        <Text tone="danger" role="alert">
          조회 전용 계정입니다. 조명 제어는 제어 권한이 있는 계정만 사용할 수 있습니다.
        </Text>
      ) : null}

      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-4 overflow-y-auto overscroll-contain tablet:grid-cols-[minmax(0,1fr)_22rem] tablet:grid-rows-[minmax(0,1fr)_10rem] tablet:overflow-hidden" data-control-layout="">
        <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden p-4" aria-label="제어 대상 지도" data-control-target-card="">
          <SpatialTargetSelector
            key={data.site.id}
            siteId={data.site.id}
            dashboard={data}
            selection={selection}
            disabled={controlsLocked}
            compactSummary={<DimmingExecutionControls compact brightness={brightness} controlsLocked={controlsLocked} canSubmit={canSubmit}
              applyLabel={manualApplyLabel(commandSessionBlocked, controlsLocked, readOnly, selectedFixtures.length)}
              selectedFixtureCount={selectedFixtures.length} blockedFixtureCount={resolvedSelection?.blockedFixtureIds.length ?? 0} delivery={deliveryLabel(selection, selectedFixtures.length)}
              onBrightnessChange={setBrightness} onSubmit={submitCommand} />}
            onChange={(nextSelection) => {
              setSelection(nextSelection);
              const nextResolved = resolveControlSelection(data, nextSelection);
              if (nextSelection.mode === "fixtures" && nextResolved.fixtureIds.length === 1) {
                const [fixture] = nextResolved.fixtures;
                if (fixture) setBrightness(fixture.brightness);
              }
              setMessage("");
            }}
          />
        </Card>

        <SidePanel className="hidden min-h-0 w-full flex-col gap-4 overflow-hidden p-4 compact:flex" aria-label="밝기 실행" data-control-panel="">
          <div className="flex min-h-14 flex-none items-start justify-between gap-3">
            <div className="grid min-w-0 gap-1">
              <Text as="span" variant="overline" tone="muted">선택 대상</Text>
              <Heading as="h3" variant="card-title" className="truncate">{selectedName}</Heading>
            </div>
            <ManualControlBadge readOnly={readOnly} canSubmit={canSubmit} blocked={Boolean(blockMessage)} />
          </div>

          <DimmingExecutionControls brightness={brightness} controlsLocked={controlsLocked} canSubmit={canSubmit}
            applyLabel={manualApplyLabel(commandSessionBlocked, controlsLocked, readOnly, selectedFixtures.length)}
            selectedFixtureCount={selectedFixtures.length} blockedFixtureCount={resolvedSelection?.blockedFixtureIds.length ?? 0} delivery={deliveryLabel(selection, selectedFixtures.length)}
            onBrightnessChange={setBrightness} onSubmit={submitCommand} />
          <div className="grid min-h-0 max-h-28 flex-none content-start gap-3 overflow-y-auto overscroll-contain" data-control-panel-feedback="">
            <div className="grid min-h-px gap-3 empty:min-h-0" role="status" aria-label="명령 진행 상태" aria-live="polite" data-command-status-region="">
              {scopedActiveRequest && !scopedCommandId ? (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => void sendCommand(scopedActiveRequest, userId)}
                  disabled={isSubmitting || commandSessionBlocked}
                >
                  동일 요청 확인(새 제어 아님)
                </Button>
              ) : null}
              {message ? <Text tone={message.startsWith("명령을 전송") ? "success" : "danger"}>{message}</Text> : null}
              {verificationError ? <Text tone="danger" role="alert">{verificationError}</Text> : null}
              {displayedStatus ? <>
                <CommandProgress status={displayedStatus} />
                <CommandOutcomeActions status={displayedStatus} onCheck={() => void checkActualState()} onRetry={() => void safelyReapply()}
                  checkResponseLost={verificationRequest?.responseLost}
                  disabled={readOnly || commandSessionBlocked || isSubmitting || restorePending || Boolean(verificationRequest?.dispatchIds)} />
                <Button variant="secondary" type="button" disabled={commandInProgress || isSubmitting} onClick={() => setTerminalResult(null)}>명령 상세 닫기</Button>
              </> : null}
            </div>
            {blockMessage ? <Text tone="danger" role="alert">{blockMessage}</Text> : null}
            {hasMismatchedCommandStatus && !missingCommand ? (
              <div className="grid gap-2" role="alert">
                <Text tone="danger">
                  명령 상태 응답의 식별자가 일치하지 않습니다. 안전을 위해 제어 잠금을 유지합니다.
                </Text>
                <Button variant="secondary" type="button" onClick={() => void commandQuery.refetch()} disabled={commandQuery.isFetching}>
                  {commandQuery.isFetching ? "명령 상태 조회 중" : "명령 상태 다시 조회"}
                </Button>
              </div>
            ) : null}
            {commandQuery.error && scopedCommandId && !missingCommand && !matchingCommandIsTerminal && !hasMismatchedCommandStatus ? (
              <div className="grid gap-2" role="alert">
                <Text tone="danger">명령 상태를 불러오지 못했습니다. 연결을 확인한 뒤 다시 조회하세요.</Text>
                <Button variant="secondary" type="button" onClick={() => void commandQuery.refetch()} disabled={commandQuery.isFetching}>
                  {commandQuery.isFetching ? "명령 상태 조회 중" : "명령 상태 다시 조회"}
                </Button>
              </div>
            ) : null}
          </div>
        </SidePanel>
        <CommandHistoryPanel key={`${userId}:${data.site.id}`} userId={userId} siteId={data.site.id}
          onSelect={openHistoricalCommand} selectedCommandId={displayedStatus?.id}
          disabled={commandInProgress || isSubmitting || restorePending || commandSessionBlocked}
          compactDisclosure className="tablet:col-span-full" />
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

function DimmingExecutionControls({ compact = false, brightness, controlsLocked, canSubmit, applyLabel, selectedFixtureCount, blockedFixtureCount, delivery, onBrightnessChange, onSubmit }: {
  compact?: boolean;
  brightness: number;
  controlsLocked: boolean;
  canSubmit: boolean;
  applyLabel: string;
  selectedFixtureCount: number;
  blockedFixtureCount: number;
  delivery: string;
  onBrightnessChange: (value: number) => void;
  onSubmit: () => void;
}) {
  return <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto overscroll-contain" data-control-panel-body="">
    {!compact ? <div className="grid gap-1 rounded-control bg-surface-inset p-3" aria-live="polite">
      <Text as="strong" weight="semibold">{selectedFixtureCount}개 선택 · 제어 불가 {blockedFixtureCount}개</Text>
      <Text as="span" variant="caption" tone="secondary">{delivery}</Text>
    </div> : null}
    <div className="grid gap-3 rounded-panel border border-border-default bg-surface-panel p-4" data-control-brightness-card="">
      <div className="flex items-baseline justify-between gap-3">
        <Text as="span" variant="label">밝기</Text>
        <Text as="strong" variant="metric">{brightness}%</Text>
      </div>
      <Slider label="밝기" minValue={0} maxValue={100} step={1} value={brightness} isDisabled={controlsLocked} onChange={onBrightnessChange} />
      <NumberField
        label="밝기 수치"
        minValue={0}
        maxValue={100}
        step={1}
        value={brightness}
        isDisabled={controlsLocked}
        onChange={(value) => {
          if (value !== null && value >= 0 && value <= 100) onBrightnessChange(value);
        }}
      />
    </div>
    <div className="grid grid-cols-4 gap-2" data-control-presets="">
      {[0, 30, 70, 100].map((value) => (
        <Button key={value} variant="secondary" type="button" onClick={() => onBrightnessChange(value)} disabled={controlsLocked}>
          {value}%
        </Button>
      ))}
    </div>
    <Button variant="primary" type="button" onClick={onSubmit} disabled={!canSubmit} data-control-submit="">
      {applyLabel}
    </Button>
  </div>;
}

function manualApplyLabel(commandSessionBlocked: boolean, controlsLocked: boolean, readOnly: boolean, selectedFixtureCount: number) {
  if (commandSessionBlocked) return "로그아웃 중";
  if (controlsLocked && !readOnly) return "밝기 적용 중";
  return selectedFixtureCount ? `${selectedFixtureCount}개 조명에 밝기 적용` : "밝기 적용";
}

function ManualControlBadge({ readOnly, canSubmit, blocked }: { readOnly: boolean; canSubmit: boolean; blocked: boolean }) {
  if (readOnly) return <StatusBadge tone="neutral" icon={Eye}>조회 전용</StatusBadge>;
  if (canSubmit) return <StatusBadge tone="success" icon={CircleCheck}>전송 가능</StatusBadge>;
  if (blocked) return <StatusBadge tone="danger" icon={TriangleAlert}>제어 불가</StatusBadge>;
  return <StatusBadge tone="neutral" icon={Clock3}>대상 없음</StatusBadge>;
}

function selectionName(
  data: ReturnType<typeof useControlDashboard>["data"],
  selection: ControlSelection,
  fixtureCount: number
) {
  if (!data) return "대상 선택";
  if (selection.mode === "fixtures") return fixtureCount === 1
    ? data.floors.flatMap((floor) => floor.fixtures).find((fixture) => fixture.id === selection.fixtureIds[0])?.name ?? "대상 선택"
    : fixtureCount > 1 ? `${fixtureCount}개 조명` : "대상 선택";
  if (selection.mode === "floor") return data.floors.find((floor) => floor.id === selection.floorId)?.name ?? "층 선택";
  return data.groups.find((group) => group.id === selection.groupId)?.name ?? "구역 선택";
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
  const latestDispatches = (status.verificationAttemptCount ?? 0) > 0
    ? status.dispatches.filter((dispatch) => dispatch.kind === "status_check" && dispatch.verificationAttempt === status.verificationAttemptCount)
    : status.dispatches;
  const failedResults = latestDispatches.flatMap((dispatch) =>
    dispatch.results.filter((result) => result.status === "failed" || result.status === "timed_out")
      .map((result) => ({ ...result, dispatchId: dispatch.id }))
  );
  const isFailure = status.stage === "partial_failed" || status.stage === "failed" || status.stage === "timed_out";
  return (
    <div className="grid gap-2 rounded-panel border border-border-default bg-surface-panel p-4" data-command-progress-card="">
      <Text as="span" variant="overline" tone="muted">최근 명령 상태</Text>
      <Text as="strong" weight="semibold">{status.stage === "completed" ? "조명 적용 완료 · 기본 밝기로 저장됨" : commandStageLabel(status.stage)}</Text>
      <Text variant="caption">{status.completedFixtureCount} / {status.totalFixtureCount} 처리</Text>
      <ProgressSteps label="명령 진행" steps={commandSteps(status.stage)} />
      {failedResults.map((result) => (
        <Text variant="caption" tone={isFailure ? "danger" : "primary"} key={`${result.dispatchId}:${result.fixtureId}`}>
          {result.fixtureName}: {humanizeDeviceResponseMessage(result.errorMessage ?? (result.status === "timed_out" ? "응답 시간 초과" : "적용 실패"))}
        </Text>
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
  const currentRank = isTerminalCommandStage(stage)
    ? 3
    : stageRank[stage as keyof typeof stageRank];
  const stepRank = stageRank[step];
  if (currentRank > stepRank) return "complete";
  if (currentRank === stepRank) return "current";
  return "pending";
}

function terminalStepState(stage: CommandStage): ProgressStepState {
  if (stage === "completed" || stage === "verified_applied") return "complete";
  if (stage === "verification_required" || stage === "verified_not_applied" || stage === "verified_partial") return "error";
  if (stage === "partial_failed" || stage === "failed" || stage === "timed_out") return "error";
  return "pending";
}

function commandStageLabel(stage: CommandStage) {
  return COMMAND_STAGE_LABELS[stage];
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
  if (error.status === 409 && error.body && typeof error.body === "object"
    && "code" in error.body && error.body.code === "uncertain_command_requires_status_check") {
    return "상태가 불확실한 명령과 대상이 겹칩니다. 명령 이력에서 실제 상태를 먼저 확인하세요.";
  }
  if (error.status === 409) return "동일 요청 ID가 다른 제어 내용과 충돌했습니다. 새 제어 요청을 실행하세요.";
  return `제어 요청이 거부되었습니다(${error.status}). 입력과 권한을 확인하세요.`;
}
