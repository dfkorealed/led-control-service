import { CircleCheck, Clock3, Eye, Layers3, TriangleAlert } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CreateDimmingCommandInput } from "@led-control/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import type { AuthUser } from "../../api/auth";
import { Button, Card, Heading, NumberField, ProgressSteps, SidePanel, Slider, StatusBadge, Text, useSessionStatus, type ProgressStep, type ProgressStepState, type SessionStatusItem } from "../../components/ui";
import {
  canonicalizeDimmingCommandInput,
  createDimmingCommand,
  createCommandStatusCheck,
  listCommandVerificationCases,
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
  clearObservedVerificationCase,
  isActiveCommandReplayRejected,
  loadActiveCommandReplayRejectedCaseId,
  loadReconciledOriginalCommandId,
  loadRecentResolvedCaseId,
  markActiveCommandCaseReconciled,
  loadActiveCommandId,
  loadActiveCommandRequest,
  loadObservedVerificationCase,
  markActiveCommandReplayRejected,
  saveActiveCommandId,
  saveActiveCommandRequest,
  saveObservedVerificationCase,
  saveRecentResolvedCaseId
} from "./active-command-store";
import { controlSelectionToDimmingTarget, resolveControlSelection, type ControlSelection } from "./control-selection";
import { humanizeDeviceResponseMessage } from "./control-copy";
import { FixtureGroupDialog } from "./FixtureGroupDialog";
import { ControlModeTabs, type ControlPageMode } from "./automation/ControlModeTabs";
import { CommandHistoryPanel, COMMAND_STAGE_LABELS } from "./CommandHistoryPanel";
import { CommandVerificationCases } from "./CommandVerificationCases";
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
  const [replayRejected, setReplayRejected] = useState(false);
  const [reconciledOriginalCommandId, setReconciledOriginalCommandId] = useState<string | null>(null);
  const [terminalResult, setTerminalResult] = useState<{ siteId: string; status: CommandStatusResponse } | null>(null);
  const [verificationRequest, setVerificationRequest] = useState<{
    commandId: string; clientRequestId: string; dispatchIds?: string[]; responseLost?: boolean;
  } | null>(null);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const groupDialogOpenerRef = useRef<HTMLButtonElement>(null);
  const [verificationCasesOpen, setVerificationCasesOpen] = useState(false);
  const verificationCasesOpenerRef = useRef<HTMLButtonElement>(null);
  const [knownVerificationCase, setKnownVerificationCase] = useState<{ siteId: string; userId: string; originalCommandId: string; caseId: string } | null>(null);
  const [recentResolvedCaseId, setRecentResolvedCaseId] = useState<string | null>(null);
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
  const exactVerificationCases = useQuery({
    queryKey: ["command-verification-cases-exact", userId, activeSiteId, scopedCommandId],
    queryFn: () => listCommandVerificationCases({ siteId: activeSiteId!, originalCommandId: scopedCommandId!, limit: 1 }),
    enabled: Boolean(activeSiteId && (!siteId || siteId === activeSiteId) && scopedCommandId && missingCommand && !matchingCommandIsTerminal),
    retry: false,
    refetchOnMount: "always"
  });
  const reconciledCaseRead = useQuery({
    queryKey: ["command-reconciled-case-exact", userId, activeSiteId, reconciledOriginalCommandId],
    queryFn: () => listCommandVerificationCases({ siteId: activeSiteId!, originalCommandId: reconciledOriginalCommandId!, limit: 1 }),
    enabled: Boolean(activeSiteId && (!siteId || siteId === activeSiteId) && scopedActiveRequest && replayRejected && reconciledOriginalCommandId),
    retry: false,
    refetchOnMount: "always",
    refetchInterval: 5000
  });
  const resolvedSelection = useMemo(
    () => data ? resolveControlSelection(data, selection) : null,
    [data, selection]
  );
  const selectedFixtures = resolvedSelection?.fixtures ?? [];
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
  const statusItems = useMemo<SessionStatusItem[]>(() => {
    // Dashboard data can lag behind a site switch. Never register a previous
    // site's command under the newly selected site's session status source.
    if (!activeSiteId || (siteId && siteId !== activeSiteId) || !commandScopeMatches) return [];
    const status = displayedStatus?.siteId && displayedStatus.siteId !== activeSiteId ? null : displayedStatus;
    const pendingRequest = !scopedCommandId ? scopedActiveRequest : null;
    const needsReview = status && [
      "partial_failed", "failed", "timed_out", "verification_required", "verified_not_applied", "verified_partial"
    ].includes(status.stage);
    if (!pendingRequest && !scopedCommandId && !needsReview) return [];

    const identity = pendingRequest?.clientRequestId ?? status?.id ?? scopedCommandId;
    const stage = status?.stage;
    const checking = Boolean(verificationRequest);
    const missingHold = Boolean(scopedCommandId && missingCommand && !matchingCommandIsTerminal);
    const statusMismatch = hasMismatchedCommandStatus && !missingCommand;
    const statusLookupFailed = Boolean(scopedCommandId && commandQuery.error && !missingCommand
      && !matchingCommandIsTerminal && !statusMismatch);
    const tone = missingHold || statusMismatch || statusLookupFailed || needsReview || checking || (pendingRequest && !isSubmitting) ? "warning" : "info";
    const title = missingHold ? "명령 원본 확인 필요" : statusMismatch ? "명령 상태 응답 확인 필요"
      : statusLookupFailed ? "명령 상태 조회 실패"
      : checking ? "실제 상태 확인 중" : pendingRequest
      ? isSubmitting ? "명령 전송 중" : "명령 응답을 확인하지 못했습니다"
      : stage ? commandStageLabel(stage) : "명령 상태 확인 중";
    const issueKind = missingHold ? "missing-command" : statusMismatch ? "identity-mismatch" : statusLookupFailed ? "lookup-failure" : "status";
    return [{
      id: `control:manual:${userId}:${activeSiteId}:command:${identity}:${issueKind}`,
      fingerprint: missingHold ? "missing-command" : statusMismatch ? `identity-mismatch:${commandQuery.data?.id}` : statusLookupFailed ? "lookup-failure"
        : `${stage ?? "pending"}:${checking ? "checking" : "idle"}:${pendingRequest ? isSubmitting ? "sending" : "response-unknown" : "known"}`,
      source: "command",
      tone,
      title,
      description: "수동 제어의 최근 결과에서 상태를 확인하세요.",
      announce: tone !== "info",
      action: { label: "수동 제어로 이동", onAction: () => selectMode("manual") }
    }];
  }, [activeSiteId, commandQuery.data?.id, commandQuery.error, commandScopeMatches, displayedStatus, hasMismatchedCommandStatus,
    isSubmitting, location.pathname, location.search, matchingCommandIsTerminal, missingCommand, scopedActiveRequest,
    scopedCommandId, siteId, userId, verificationRequest]);
  useSessionStatus(`control:manual:${userId}:${activeSiteId ?? siteId ?? "none"}`, statusItems);

  useEffect(() => {
    if (!capabilities) return;
    if (requestedMode === mode) return;
    const search = new URLSearchParams(location.search);
    search.set("mode", mode);
    void navigate({ pathname: location.pathname, search: `?${search.toString()}` }, { replace: true });
  }, [capabilities, location.pathname, location.search, mode, navigate, requestedMode]);

  useEffect(() => {
    if (mode !== "manual") {
      setGroupDialogOpen(false);
      setVerificationCasesOpen(false);
    }
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
    setVerificationCasesOpen(false);
    setCommandUserId(userId);
    setCommandSiteId(activeSiteId);
    setActiveRequest(activeSiteId ? loadActiveCommandRequest(userId, activeSiteId) : null);
    const restoredRequest = activeSiteId ? loadActiveCommandRequest(userId, activeSiteId) : null;
    setReplayRejected(Boolean(restoredRequest && isActiveCommandReplayRejected(userId, activeSiteId!, restoredRequest.clientRequestId)));
    setReconciledOriginalCommandId(restoredRequest && activeSiteId
      ? loadReconciledOriginalCommandId(userId, activeSiteId, restoredRequest.clientRequestId) : null);
    const restoredCommandId = activeSiteId ? loadActiveCommandId(userId, activeSiteId) : null;
    const observedCaseId = activeSiteId && restoredCommandId
      ? loadObservedVerificationCase(userId, activeSiteId, restoredCommandId) : null;
    setKnownVerificationCase(observedCaseId && activeSiteId && restoredCommandId
      ? { siteId: activeSiteId, userId, originalCommandId: restoredCommandId, caseId: observedCaseId } : null);
    setRecentResolvedCaseId(activeSiteId ? loadRecentResolvedCaseId(userId, activeSiteId) : null);
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
    if (!activeSiteId || !scopedActiveRequest || !replayRejected || !reconciledOriginalCommandId
      || siteId && siteId !== activeSiteId || reconciledCaseRead.isFetching || !reconciledCaseRead.isFetchedAfterMount
      || reconciledCaseRead.error || !reconciledCaseRead.data || reconciledCaseRead.data.items.length !== 0) return;
    const caseId = loadActiveCommandReplayRejectedCaseId(userId, activeSiteId, scopedActiveRequest.clientRequestId);
    if (!caseId || loadReconciledOriginalCommandId(userId, activeSiteId, scopedActiveRequest.clientRequestId) !== reconciledOriginalCommandId) return;
    // A successful audit POST is not unlock evidence. A fresh authorized exact
    // read must show that the previously observed blocking case is gone.
    if (!clearActiveCommandRequest(userId, activeSiteId, scopedActiveRequest.clientRequestId)) return;
    saveRecentResolvedCaseId(userId, activeSiteId, caseId);
    setRecentResolvedCaseId(caseId);
    setActiveRequest(null);
    setReplayRejected(false);
    setReconciledOriginalCommandId(null);
    setMessage("확인 필요 명령이 서버에서 해소되었습니다. 새 제어가 필요하면 다시 적용하세요.");
  }, [activeSiteId, reconciledCaseRead.data, reconciledCaseRead.error, reconciledCaseRead.isFetchedAfterMount,
    reconciledCaseRead.isFetching, reconciledOriginalCommandId, replayRejected, scopedActiveRequest, siteId, userId]);

  useEffect(() => {
    if (!activeSiteId || !scopedCommandId || !missingCommand || matchingCommandIsTerminal
      || siteId && siteId !== activeSiteId || exactVerificationCases.isFetching || !exactVerificationCases.isFetchedAfterMount || exactVerificationCases.error
      || !exactVerificationCases.data) return;
    const caseRecord = exactVerificationCases.data.items.find((item) => item.siteId === activeSiteId && item.originalCommandId === scopedCommandId);
    if (caseRecord) {
      if (knownVerificationCase?.siteId !== activeSiteId || knownVerificationCase.userId !== userId
        || knownVerificationCase.originalCommandId !== scopedCommandId || knownVerificationCase.caseId !== caseRecord.caseId) {
        setKnownVerificationCase({ siteId: activeSiteId, userId, originalCommandId: scopedCommandId, caseId: caseRecord.caseId });
        saveObservedVerificationCase(userId, activeSiteId, scopedCommandId, caseRecord.caseId);
      }
      return;
    }
    if (exactVerificationCases.data.items.length !== 0 || !knownVerificationCase
      || knownVerificationCase.siteId !== activeSiteId || knownVerificationCase.userId !== userId
      || knownVerificationCase.originalCommandId !== scopedCommandId) return;
    // An authorized exact-filter read after a previously observed case is the
    // only case-specific evidence that the server has released its hold.
    // A standalone 404/410 or an initially empty list is never enough.
    clearActiveCommandId(userId, activeSiteId, scopedCommandId);
    clearObservedVerificationCase(userId, activeSiteId, scopedCommandId, knownVerificationCase.caseId);
    saveRecentResolvedCaseId(userId, activeSiteId, knownVerificationCase.caseId);
    setRecentResolvedCaseId(knownVerificationCase.caseId);
    setActiveRequest(null);
    setVerificationRequest(null);
    setCommandId(null);
    setKnownVerificationCase(null);
    setMessage("확인 필요 case가 서버에서 해소된 것을 확인했습니다.");
  }, [activeSiteId, exactVerificationCases.data, exactVerificationCases.error, exactVerificationCases.isFetchedAfterMount, exactVerificationCases.isFetching,
    knownVerificationCase, matchingCommandIsTerminal, missingCommand, scopedCommandId, siteId, userId]);

  useEffect(() => {
    if (!activeSiteId || !scopedCommandId || !matchingCommandStatus || !matchingCommandIsTerminal || isSubmitting) return;

    setTerminalResult({ siteId: activeSiteId, status: matchingCommandStatus });
    clearActiveCommandId(userId, activeSiteId, scopedCommandId);
    const observedCaseId = loadObservedVerificationCase(userId, activeSiteId, scopedCommandId);
    if (observedCaseId) clearObservedVerificationCase(userId, activeSiteId, scopedCommandId, observedCaseId);
    setActiveRequest(null);
    setVerificationRequest(null);
    setCommandId((currentCommandId) => currentCommandId === scopedCommandId ? null : currentCommandId);
    setMessage("");
    void queryClient.invalidateQueries({ queryKey: ["command-history", userId] });
  }, [activeSiteId, isSubmitting, matchingCommandIsTerminal, matchingCommandStatus, queryClient, scopedCommandId, userId]);

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
    setReplayRejected(false);
    setReconciledOriginalCommandId(null);
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
    setReplayRejected(false);
    setReconciledOriginalCommandId(null);
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
      } else if (isSafetySensitiveCommandError(error)) {
        setVerificationRequest({ ...request, responseLost: true });
        setVerificationError("실제 상태를 확인하기 전까지 제어 잠금을 유지합니다. 확인 필요한 명령을 조회하세요.");
        void queryClient.invalidateQueries({ queryKey: ["command-verification-cases", userId] });
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
    if (isActiveCommandReplayRejected(requestUserId, request.siteId, request.clientRequestId)) return;
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
      if (isDefinitiveCommandRejection(error) || isGatewayRecommissionRejection(error)) {
        clearActiveCommandRequest(requestUserId, request.siteId, request.clientRequestId);
        setActiveRequest(null);
        setCommandId(null);
        setReplayRejected(false);
        setReconciledOriginalCommandId(null);
        setMessage(definitiveRejectionMessage(error));
      } else if (isSafetySensitiveCommandError(error)) {
        const caseId = safetyRejectionCaseId(error);
        markActiveCommandReplayRejected(requestUserId, request.siteId, request.clientRequestId, caseId ?? undefined);
        setReplayRejected(true);
        setReconciledOriginalCommandId(null);
        setMessage("서버가 요청을 안전상 거부했습니다. 실제 상태를 확인하기 전까지 제어 잠금을 유지합니다. 이 요청은 재전송할 수 없습니다.");
        void queryClient.invalidateQueries({ queryKey: ["command-verification-cases", requestUserId] });
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

  function handleCaseReconciled(caseId: string, originalCommandId: string) {
    if (!activeSiteId || !scopedActiveRequest || !replayRejected
      || activeScope.current.userId !== userId || activeScope.current.siteId !== activeSiteId
      || loadActiveCommandReplayRejectedCaseId(userId, activeSiteId, scopedActiveRequest.clientRequestId) !== caseId) return;
    // Only the authorized successful audit for the exact blocking case releases
    // this locally rejected request. A subsequent Set needs a new Apply/UUID.
    if (!markActiveCommandCaseReconciled(userId, activeSiteId, scopedActiveRequest.clientRequestId, caseId, originalCommandId)) return;
    setReconciledOriginalCommandId(originalCommandId);
    setMessage("위험 승인은 기록되었습니다. 서버의 확인 필요 목록을 다시 확인할 때까지 잠금을 유지합니다.");
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
    <section className={`${controlScreenClassName} max-compact:overflow-y-auto max-compact:overscroll-contain`} data-control-screen="">
      {modeTabs}
      <div id="control-mode-panel-manual" role="tabpanel" aria-labelledby="control-mode-manual" className="grid min-h-0 min-w-0 gap-4 tablet:flex tablet:flex-1 tablet:flex-col" data-control-manual-panel="">
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-4 overflow-y-auto overscroll-contain compact:grid-cols-[minmax(0,1fr)_350px] compact:grid-rows-[minmax(0,1fr)_auto] compact:overflow-hidden" data-control-layout="">
        <Card className="flex min-h-[25rem] min-w-0 flex-col overflow-hidden p-4 max-compact:min-h-0 max-compact:overflow-visible compact:min-h-0" aria-label="제어 대상 지도" data-control-target-card="">
          <SpatialTargetSelector
            key={data.site.id}
            siteId={data.site.id}
            dashboard={data}
            selection={selection}
            disabled={controlsLocked}
            hideEmbeddedSummary
            managementAction={<Button ref={groupDialogOpenerRef} variant="secondary" type="button" onClick={() => setGroupDialogOpen(true)}
              disabled={commandSessionBlocked || isSubmitting || restorePending || commandInProgress}>
              <Layers3 size={16} aria-hidden="true" /> {canManage ? "구역 관리" : "구역 현황"}
            </Button>}
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

        <SidePanel className="flex min-h-0 w-full flex-col gap-4 p-4 compact:overflow-hidden" aria-label="밝기 실행" data-control-panel="">
          <div className="flex flex-none items-start justify-between gap-3">
            <Text as="strong" variant="label" aria-live="polite" aria-atomic="true">{selectedFixtures.length}개 선택</Text>
            <ManualControlBadge readOnly={readOnly} canSubmit={canSubmit} blocked={Boolean(blockMessage)} />
          </div>
          <DimmingExecutionControls brightness={brightness} controlsLocked={controlsLocked} canSubmit={canSubmit}
            applyLabel={manualApplyLabel(commandSessionBlocked, controlsLocked, readOnly, selectedFixtures.length)}
            onBrightnessChange={setBrightness} onSubmit={submitCommand} />
          {/* Selection warnings belong below the fixed execution controls so
              late health/capability text cannot move the dial or Apply action. */}
          {blockMessage ? <Text tone="danger" role="alert">{blockMessage}</Text> : null}
          <ManualControlFeedback scopedActiveRequest={scopedActiveRequest} scopedCommandId={scopedCommandId}
            replayRejected={replayRejected}
            awaitingCaseRelease={Boolean(reconciledOriginalCommandId)} isCaseReleaseFetching={reconciledCaseRead.isFetching}
            onRefreshCaseRelease={() => void reconciledCaseRead.refetch()}
            isSubmitting={isSubmitting} commandSessionBlocked={commandSessionBlocked} message={message} verificationError={verificationError}
            displayedStatus={displayedStatus} onRetryPending={() => void sendCommand(scopedActiveRequest!, userId)} onCheck={() => void checkActualState()}
            onReapply={() => void safelyReapply()} readOnly={readOnly} restorePending={restorePending} verificationRequest={verificationRequest}
            commandInProgress={commandInProgress} onCloseDetail={() => setTerminalResult(null)}
            hasMismatchedCommandStatus={hasMismatchedCommandStatus} missingCommand={missingCommand} matchingCommandIsTerminal={matchingCommandIsTerminal} commandError={commandQuery.error}
            isCommandFetching={commandQuery.isFetching} onRefreshStatus={() => void commandQuery.refetch()} />
        </SidePanel>
        <CommandHistoryPanel key={`${userId}:${data.site.id}`} userId={userId} siteId={data.site.id}
          timeZone={data.site.timeZone}
          onSelect={openHistoricalCommand} selectedCommandId={displayedStatus?.id}
          disabled={commandInProgress || isSubmitting || restorePending || commandSessionBlocked}
          onOpenVerificationCases={() => setVerificationCasesOpen(true)} verificationCasesOpenerRef={verificationCasesOpenerRef}
          verificationCaseCount={missingCommand ? exactVerificationCases.data?.items.length : undefined}
          compactDisclosure className="compact:col-span-full" />
      </div>
      <FixtureGroupDialog
        open={groupDialogOpen}
        siteId={data.site.id}
        dashboard={data}
        canManage={canManage}
        returnFocusRef={groupDialogOpenerRef}
        onClose={() => setGroupDialogOpen(false)}
      />
      <CommandVerificationCases key={`${userId}:${data.site.id}`} open={verificationCasesOpen} siteId={data.site.id} userId={userId}
        canControl={canControl} canManage={canManage} originalCommandId={missingCommand ? scopedCommandId ?? undefined : undefined}
        onReconciled={handleCaseReconciled}
        recentCaseId={recentResolvedCaseId}
        timeZone={data.site.timeZone}
        returnFocusRef={verificationCasesOpenerRef} onClose={() => setVerificationCasesOpen(false)} />
      </div>
    </section>
  );
}

function DimmingExecutionControls({ compact = false, brightness, controlsLocked, canSubmit, applyLabel, onBrightnessChange, onSubmit }: {
  compact?: boolean;
  brightness: number;
  controlsLocked: boolean;
  canSubmit: boolean;
  applyLabel: string;
  onBrightnessChange: (value: number) => void;
  onSubmit: () => void;
}) {
  return <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto overscroll-contain" data-control-panel-body="">
    {!compact ? <Heading as="h4" variant="card-title">밝기</Heading> : null}
    <div className="grid gap-3 rounded-panel border border-border-default bg-surface-panel p-4" data-control-brightness-card="">
      <div className="flex items-baseline justify-between gap-3">
        <Text as="span" variant="label">밝기</Text>
        <Text as="strong" variant="metric">{brightness}%</Text>
      </div>
      <Slider label="밝기" minValue={0} maxValue={100} step={1} value={brightness} isDisabled={controlsLocked} onChange={onBrightnessChange} />
      {!compact ? <NumberField
        label="밝기 수치"
        size={compact ? "lg" : "md"}
        minValue={0}
        maxValue={100}
        step={1}
        value={brightness}
        isDisabled={controlsLocked}
        onChange={(value) => {
          if (value !== null && value >= 0 && value <= 100) onBrightnessChange(value);
        }}
      /> : null}
    </div>
    <div className="grid grid-cols-4 gap-2" data-control-presets="">
      {[0, 30, 70, 100].map((value) => (
        <Button key={value} variant="secondary" type="button" className={compact ? "min-h-13" : undefined} onClick={() => onBrightnessChange(value)} disabled={controlsLocked}>
          {value}%
        </Button>
      ))}
    </div>
    {!compact ? <Button variant="primary" type="button" onClick={onSubmit} disabled={!canSubmit} data-control-submit="">
      {applyLabel}
    </Button> : null}
  </div>;
}

function manualApplyLabel(commandSessionBlocked: boolean, controlsLocked: boolean, readOnly: boolean, selectedFixtureCount: number) {
  if (commandSessionBlocked) return "로그아웃 중";
  if (controlsLocked && !readOnly) return "밝기 적용 중";
  return selectedFixtureCount ? `${selectedFixtureCount}개 조명에 밝기 적용` : "밝기 적용";
}

function ManualControlFeedback({ compact = false, scopedActiveRequest, scopedCommandId, replayRejected, awaitingCaseRelease, isCaseReleaseFetching, onRefreshCaseRelease, isSubmitting, commandSessionBlocked, message, verificationError,
  displayedStatus, onRetryPending, onCheck, onReapply, readOnly, restorePending, verificationRequest, commandInProgress, onCloseDetail,
  hasMismatchedCommandStatus, missingCommand, matchingCommandIsTerminal, commandError, isCommandFetching, onRefreshStatus }: {
  compact?: boolean;
  scopedActiveRequest: CreateDimmingCommandInput | null;
  scopedCommandId: string | null;
  replayRejected: boolean;
  awaitingCaseRelease: boolean;
  isCaseReleaseFetching: boolean;
  onRefreshCaseRelease: () => void;
  isSubmitting: boolean;
  commandSessionBlocked: boolean;
  message: string;
  verificationError: string;
  displayedStatus: CommandStatusResponse | null;
  onRetryPending: () => void;
  onCheck: () => void;
  onReapply: () => void;
  readOnly: boolean;
  restorePending: boolean;
  verificationRequest: { dispatchIds?: string[]; responseLost?: boolean } | null;
  commandInProgress: boolean;
  onCloseDetail: () => void;
  hasMismatchedCommandStatus: boolean;
  missingCommand: boolean;
  matchingCommandIsTerminal: boolean;
  commandError: unknown;
  isCommandFetching: boolean;
  onRefreshStatus: () => void;
}) {
  return <div className={compact ? "grid gap-3" : "grid min-h-0 max-h-28 flex-none content-start gap-3 overflow-y-auto overscroll-contain"} data-control-panel-feedback="">
    <Heading as="h4" variant={compact ? "label" : "card-title"}>최근 결과</Heading>
    <div className="grid min-h-px gap-3 empty:min-h-0" role="status" aria-label="명령 진행 상태" aria-live="polite" data-command-status-region="">
      {scopedActiveRequest && !scopedCommandId && !replayRejected ? <Button variant="secondary" type="button" onClick={onRetryPending} disabled={isSubmitting || commandSessionBlocked}>
        동일 요청 확인(새 제어 아님)
      </Button> : null}
      {scopedActiveRequest && !scopedCommandId && replayRejected ? <Text tone="danger">안전을 위해 재전송할 수 없습니다. 확인 필요한 명령을 조회하세요.</Text> : null}
      {scopedActiveRequest && replayRejected && awaitingCaseRelease ? <div className="grid gap-2">
        <Text tone="warning">위험 승인은 기록됐습니다. 서버의 차단 해제를 확인할 때까지 새 제어는 잠겨 있습니다.</Text>
        <Button type="button" variant="secondary" disabled={isCaseReleaseFetching} onClick={onRefreshCaseRelease}>차단 상태 다시 조회</Button>
      </div> : null}
      {message ? <Text tone={message.startsWith("명령을 전송") ? "success" : "danger"}>{message}</Text> : null}
      {verificationError ? <Text tone="danger" role="alert">{verificationError}</Text> : null}
      {displayedStatus ? <>
        <CommandProgress status={displayedStatus} />
        <CommandOutcomeActions status={displayedStatus} onCheck={onCheck} onRetry={onReapply}
          checkResponseLost={verificationRequest?.responseLost}
          disabled={readOnly || commandSessionBlocked || isSubmitting || restorePending || Boolean(verificationRequest?.dispatchIds)} />
        <Button variant="secondary" type="button" disabled={commandInProgress || isSubmitting} onClick={onCloseDetail}>명령 상세 닫기</Button>
      </> : null}
    </div>
    {hasMismatchedCommandStatus && !missingCommand ? <div className="grid gap-2" role="alert">
      <Text tone="danger">명령 상태 응답의 식별자가 일치하지 않습니다. 안전을 위해 제어 잠금을 유지합니다.</Text>
      <Button variant="secondary" type="button" onClick={onRefreshStatus} disabled={isCommandFetching}>
        {isCommandFetching ? "명령 상태 조회 중" : "명령 상태 다시 조회"}
      </Button>
    </div> : null}
    {missingCommand && scopedCommandId && !matchingCommandIsTerminal ? <div className="grid gap-2" role="alert">
      <Text tone="danger">명령 원본을 찾을 수 없습니다. 실제 상태 확인 전까지 제어 잠금을 유지합니다.</Text>
      <Button variant="secondary" type="button" onClick={onRefreshStatus} disabled={isCommandFetching}>
        {isCommandFetching ? "명령 상태 조회 중" : "명령 상태 다시 조회"}
      </Button>
    </div> : null}
    {commandError && scopedCommandId && !missingCommand && !matchingCommandIsTerminal && !hasMismatchedCommandStatus ? <div className="grid gap-2" role="alert">
      <Text tone="danger">명령 상태를 불러오지 못했습니다. 연결을 확인한 뒤 다시 조회하세요.</Text>
      <Button variant="secondary" type="button" onClick={onRefreshStatus} disabled={isCommandFetching}>
        {isCommandFetching ? "명령 상태 조회 중" : "명령 상태 다시 조회"}
      </Button>
    </div> : null}
  </div>;
}

function ManualControlBadge({ readOnly, canSubmit, blocked }: { readOnly: boolean; canSubmit: boolean; blocked: boolean }) {
  if (readOnly) return <StatusBadge tone="neutral" icon={Eye}>조회 전용</StatusBadge>;
  if (canSubmit) return <StatusBadge tone="success" icon={CircleCheck}>전송 가능</StatusBadge>;
  if (blocked) return <StatusBadge tone="danger" icon={TriangleAlert}>제어 불가</StatusBadge>;
  return <StatusBadge tone="neutral" icon={Clock3}>대상 없음</StatusBadge>;
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
    && [404, 410].includes((error as { status?: number }).status ?? 0)
  );
}

function isDefinitiveCommandRejection(error: unknown): error is { status: number; body?: unknown } {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  // Only these responses prove this logical request was rejected before any
  // device action. An unknown 409/410 (including replay fences and holds)
  // never clears the persisted request or the UI safety lock.
  return status === 400 || status === 403
    || status === 409 && commandErrorCode(error) === "client_request_id_payload_conflict";
}

function isSafetySensitiveCommandError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 404 || status === 409 || status === 410;
}

function isGatewayRecommissionRejection(error: unknown): error is { status: number; body?: unknown } {
  // The server checks an existing clientRequestId first, then rejects fresh
  // Sets before creating a Command while the recommission fence is active.
  // Keep this exception scoped to dimming POST, not Get-only status checks.
  return Boolean(error && typeof error === "object" && "status" in error
    && error.status === 409 && commandErrorCode(error) === "gateway_recommission_in_progress");
}

function commandErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("body" in error)) return null;
  const body = (error as { body?: unknown }).body;
  return body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : null;
}

function safetyRejectionCaseId(error: unknown): string | null {
  if (commandErrorCode(error) !== "command_requires_verification" || !error || typeof error !== "object" || !("body" in error)) return null;
  const body = (error as { body?: unknown }).body;
  if (!body || typeof body !== "object" || !("caseId" in body)) return null;
  const caseId = body.caseId;
  return typeof caseId === "string" && caseId.length > 0 && caseId.length <= 128 ? caseId : null;
}

function definitiveRejectionMessage(error: { status: number; body?: unknown }): string {
  if (error.status === 403) return "제어 권한이 없습니다. 권한을 확인한 뒤 다시 시도하세요.";
  if (error.status === 409 && commandErrorCode(error) === "gateway_recommission_in_progress") return "게이트웨이 재등록이 진행 중입니다. 완료 후 새 제어 요청으로 다시 시도하세요.";
  if (error.status === 409) return "동일 요청 ID가 다른 제어 내용과 충돌했습니다. 새 제어 요청을 실행하세요.";
  return `제어 요청이 거부되었습니다(${error.status}). 입력과 권한을 확인하세요.`;
}
