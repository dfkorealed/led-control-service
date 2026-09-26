import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  createCaseStatusCheck, getCommandVerificationCase, isActiveCommandVerificationCase, isResolvedCommandVerificationCase, reconcileCommandCase, useCommandVerificationCases,
  type CommandCaseReconcileInput, type CommandVerificationCase
} from "../../api/commands";
import { ApiError, isTransientApiError } from "../../api/client";
import { Button, DrawerDialog, Text } from "../../components/ui";
import { CommandRiskReconcileDialog } from "./CommandRiskReconcileDialog";
import { clearPendingCaseStatusCheck, loadPendingCaseStatusCheck, savePendingCaseStatusCheck, saveRecentResolvedCaseId } from "./active-command-store";
import { formatControlTimestamp } from "./control-time";

export interface CommandVerificationCasesProps {
  open: boolean;
  siteId: string;
  userId: string;
  canControl: boolean;
  canManage: boolean;
  onClose: () => void;
  onReconciled?: (caseId: string, originalCommandId: string) => void;
  recentCaseId?: string | null;
  originalCommandId?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  timeZone?: string;
}

export function CommandVerificationCases({ open, siteId, userId, canControl, canManage, onClose, onReconciled, recentCaseId, originalCommandId, returnFocusRef, timeZone = "UTC" }: CommandVerificationCasesProps) {
  const queryClient = useQueryClient();
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [riskOpen, setRiskOpen] = useState(false);
  const [pendingCheck, setPendingCheck] = useState<{ caseId: string; clientRequestId: string; responseLost: boolean } | null>(null);
  const [acceptedAttempt, setAcceptedAttempt] = useState<{ caseId: string; count: number } | null>(null);
  const [blockedCase, setBlockedCase] = useState<{ caseId: string; detailUpdatedAt: number } | null>(null);
  const [checkMessage, setCheckMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const [authorizationLost, setAuthorizationLost] = useState(false);
  const scopeRef = useRef(`${userId}:${siteId}`);
  const actionControllerRef = useRef<AbortController | null>(null);
  const missingDetailRef = useRef<string | null>(null);
  const paginationGeneration = useRef(0);
  const previousButtonRef = useRef<HTMLButtonElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { paginationGeneration.current += 1; setPageIndex(0); }, [userId, siteId, originalCommandId, open]);
  useEffect(() => {
    scopeRef.current = `${userId}:${siteId}`;
    setPageIndex(0);
    setSelectedCaseId(null);
    setRiskOpen(false);
    setPendingCheck(null);
    setAcceptedAttempt(null);
    setBlockedCase(null);
    setCheckMessage("");
    missingDetailRef.current = null;
    actionControllerRef.current?.abort();
    return () => { actionControllerRef.current?.abort(); };
  }, [siteId, userId, originalCommandId]);
  useEffect(() => { setAuthorizationLost(false); }, [siteId, userId]);

  const cases = useCommandVerificationCases(userId, { siteId, ...(originalCommandId ? { originalCommandId } : {}), limit: 4 }, open);
  const listUnauthorized = cases.error instanceof ApiError && [401, 403].includes(cases.error.status);
  const detailQueryKey = ["command-verification-case", userId, siteId, selectedCaseId] as const;
  const detail = useQuery({
    queryKey: detailQueryKey,
    queryFn: () => getCommandVerificationCase(selectedCaseId!),
    enabled: open && Boolean(selectedCaseId),
    retry: false,
    refetchInterval: (query) => query.state.data?.status === "verification_in_progress"
      || acceptedAttempt?.caseId === selectedCaseId && query.state.data && isActiveCommandVerificationCase(query.state.data)
        && query.state.data.verificationAttemptCount < acceptedAttempt.count ? 1000 : false
  });
  const detailUnauthorized = detail.error instanceof ApiError && [401, 403].includes(detail.error.status);
  const permissionLost = listUnauthorized || detailUnauthorized || authorizationLost;
  const page = permissionLost ? undefined : cases.data?.pages[pageIndex];
  // React Query retains a successful detail across background refetch failure.
  // Cached data is display history, never fresh authority for Get or approval.
  const scopedDetail = !permissionLost && !detail.isFetching && !detail.error
    && detail.data?.siteId === siteId && detail.data.caseId === selectedCaseId ? detail.data : null;
  const selectedCase = scopedDetail && isActiveCommandVerificationCase(scopedDetail) ? scopedDetail : null;
  const resolvedCase = scopedDetail && isResolvedCommandVerificationCase(scopedDetail) ? scopedDetail : null;
  useEffect(() => {
    if (riskOpen && (!open || !selectedCase)) setRiskOpen(false);
  }, [open, riskOpen, selectedCase]);
  useEffect(() => {
    if (resolvedCase) saveRecentResolvedCaseId(userId, siteId, resolvedCase.caseId);
  }, [resolvedCase, siteId, userId]);
  const storedCheckId = selectedCaseId ? loadPendingCaseStatusCheck(userId, siteId, selectedCaseId) : null;
  const retryCheck = pendingCheck?.caseId === selectedCaseId ? pendingCheck
    : storedCheckId && selectedCaseId ? { caseId: selectedCaseId, clientRequestId: storedCheckId, responseLost: true } : null;
  useEffect(() => {
    if (!listUnauthorized && !detailUnauthorized) return;
    setAuthorizationLost(true);
    setSelectedCaseId(null);
    setRiskOpen(false);
    setPendingCheck(null);
  }, [listUnauthorized, detailUnauthorized]);
  useEffect(() => {
    if (!blockedCase || selectedCaseId !== blockedCase.caseId || detail.isFetching || detail.error
      || detail.dataUpdatedAt <= blockedCase.detailUpdatedAt || !selectedCase?.canRequestStatusCheck) return;
    setBlockedCase(null);
  }, [blockedCase, detail.dataUpdatedAt, detail.error, detail.isFetching, selectedCase, selectedCaseId]);
  useEffect(() => {
    if (!selectedCaseId || !(detail.error instanceof ApiError) || detail.error.status !== 404
      || missingDetailRef.current === selectedCaseId) return;
    missingDetailRef.current = selectedCaseId;
    const pendingId = loadPendingCaseStatusCheck(userId, siteId, selectedCaseId);
    if (pendingId) clearPendingCaseStatusCheck(userId, siteId, selectedCaseId, pendingId);
    // Detail 404 alone does not release a hold. It only triggers an authorized
    // exact-filter list read; ControlView decides after that fresh response.
    const originalId = cases.data?.pages.flatMap((item) => item.items).find((item) => item.caseId === selectedCaseId)?.originalCommandId;
    void queryClient.invalidateQueries({ queryKey: ["command-verification-cases", userId] });
    if (originalId) void queryClient.invalidateQueries({ queryKey: ["command-verification-cases-exact", userId, siteId, originalId] });
  }, [cases.data, detail.error, queryClient, selectedCaseId, siteId, userId]);
  const staleAcceptedAttempt = acceptedAttempt?.caseId === selectedCaseId
    && (selectedCase?.verificationAttemptCount ?? 0) < acceptedAttempt.count;
  const canCheck = canControl && selectedCase?.canRequestStatusCheck && blockedCase?.caseId !== selectedCaseId && !checking && !staleAcceptedAttempt
    && selectedCase.status !== "verification_in_progress";

  async function requestStatusCheck() {
    if (!selectedCase || !canControl || checking || !canCheck && !retryCheck?.responseLost) return;
    const query = queryClient.getQueryState(detailQueryKey);
    if (!open || scopeRef.current !== `${userId}:${siteId}` || query?.fetchStatus !== "idle"
      || query.error || query.data !== selectedCase) return;
    const request = retryCheck?.caseId === selectedCase.caseId ? retryCheck
      : { caseId: selectedCase.caseId, clientRequestId: crypto.randomUUID(), responseLost: false };
    const scope = scopeRef.current;
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setChecking(true);
    setPendingCheck(request);
    savePendingCaseStatusCheck(userId, siteId, request.caseId, request.clientRequestId);
    setCheckMessage("");
    try {
      const response = await createCaseStatusCheck(request.caseId, request.clientRequestId, controller.signal);
      if (scopeRef.current !== scope || controller.signal.aborted) return;
      setPendingCheck(null);
      clearPendingCaseStatusCheck(userId, siteId, request.caseId, request.clientRequestId);
      setAcceptedAttempt({ caseId: request.caseId, count: response.verificationAttempt });
      setCheckMessage("실제 상태 확인을 요청했습니다. 결과를 조회합니다.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["command-verification-case", userId, siteId, request.caseId] }),
        queryClient.invalidateQueries({ queryKey: ["command-verification-cases", userId] })
      ]);
    } catch (error) {
      if (scopeRef.current !== scope || controller.signal.aborted) return;
      if (isTransientApiError(error)) {
        // The server may have accepted a Get before the HTTP response was lost.
        // Retrying this same logical request must keep its clientRequestId.
        setPendingCheck({ ...request, responseLost: true });
        setCheckMessage("응답을 받지 못했습니다. 같은 상태 확인 요청만 다시 보낼 수 있습니다.");
      } else {
        setPendingCheck(null);
        clearPendingCaseStatusCheck(userId, siteId, request.caseId, request.clientRequestId);
        setBlockedCase({ caseId: request.caseId, detailUpdatedAt: detail.dataUpdatedAt });
        setCheckMessage("상태 확인 요청을 처리하지 못했습니다. case를 다시 조회하세요. 제어 잠금은 유지됩니다.");
        void queryClient.invalidateQueries({ queryKey: ["command-verification-cases", userId] });
      }
    } finally {
      if (actionControllerRef.current === controller) actionControllerRef.current = null;
      if (scopeRef.current === scope) setChecking(false);
    }
  }

  async function reconcile(input: CommandCaseReconcileInput) {
    if (!canManage || !selectedCase) throw new Error("Not authorized");
    const query = queryClient.getQueryState(detailQueryKey);
    if (!open || !riskOpen || scopeRef.current !== `${userId}:${siteId}` || query?.fetchStatus !== "idle"
      || query.error || query.data !== selectedCase) throw new Error("Case detail must be refreshed");
    const scope = scopeRef.current;
    const caseId = selectedCase.caseId;
    const controller = new AbortController();
    actionControllerRef.current = controller;
    try {
      await reconcileCommandCase(caseId, input, controller.signal);
      if (scopeRef.current !== scope || controller.signal.aborted) return;
      onReconciled?.(caseId, selectedCase.originalCommandId);
      setRiskOpen(false);
      setSelectedCaseId(null);
      const pendingId = loadPendingCaseStatusCheck(userId, siteId, caseId);
      if (pendingId) clearPendingCaseStatusCheck(userId, siteId, caseId, pendingId);
      setCheckMessage("위험 승인 결과를 기록했습니다. 서버의 확인 필요 목록과 제어 차단 상태를 다시 조회하세요.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["command-verification-cases", userId] }),
        queryClient.invalidateQueries({ queryKey: ["command-verification-cases-exact", userId, siteId, selectedCase.originalCommandId] }),
        queryClient.invalidateQueries({ queryKey: ["command-verification-case", userId, siteId, caseId] }),
        queryClient.invalidateQueries({ queryKey: ["command-history", userId] })
      ]);
    } finally {
      if (actionControllerRef.current === controller) actionControllerRef.current = null;
    }
  }

  return <>
    <DrawerDialog isOpen={open} title="확인 필요한 명령" description="원본 이력 만료 후에도 결과가 불확실한 명령을 별도 안전 기록으로 조회합니다." closeLabel="확인 필요한 명령 닫기" onClose={onClose} returnFocusRef={returnFocusRef}
      className="grid! h-dvh! w-full! max-w-status-drawer! grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden!" bodyClassName="grid min-h-0 overflow-hidden"
      actions={<div className="flex items-center justify-between gap-2 pb-safe-area-bottom"><Button ref={previousButtonRef} type="button" variant="secondary" disabled={pageIndex === 0 || cases.isFetching} onClick={() => { setPageIndex((index) => index - 1); if (pageIndex === 1) nextButtonRef.current?.focus(); }}>이전</Button><Button ref={nextButtonRef} type="button" variant="secondary" disabled={!page?.nextCursor || cases.isFetching} onClick={() => {
        const generation = paginationGeneration.current;
        const nextIndex = pageIndex + 1;
        const showNext = (hasNextCursor: boolean) => {
          if (paginationGeneration.current !== generation) return;
          setPageIndex((current) => current === pageIndex ? nextIndex : current);
          if (!hasNextCursor) queueMicrotask(() => previousButtonRef.current?.focus());
        };
        const cached = cases.data?.pages[nextIndex];
        if (cached) showNext(Boolean(cached.nextCursor));
        else void cases.fetchNextPage().then((result) => { const nextPage = result.data?.pages[nextIndex]; if (!result.isError && nextPage) showNext(Boolean(nextPage.nextCursor)); });
      }}>다음</Button></div>}>
      <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3">
        <div className="grid min-h-0 content-start gap-2 overflow-y-auto overscroll-contain" aria-label="확인 필요 case 목록">
          {cases.isPending ? <Text role="status">확인 필요한 명령을 불러오는 중입니다.</Text> : null}
          {!cases.isPending && !cases.error && !permissionLost && !page?.items.length ? <Text>확인 필요한 명령이 없습니다.</Text> : null}
          {permissionLost ? <Text role="alert" tone="danger">조회 권한이 변경되었습니다. 다시 로그인한 뒤 확인하세요. 제어 잠금은 유지됩니다.</Text> : null}
          {page?.items.map((item) => <CaseRow key={item.caseId} item={item} selected={selectedCaseId === item.caseId} onSelect={() => { setSelectedCaseId(item.caseId); setCheckMessage(""); }} />)}
          {recentCaseId && !permissionLost && !page?.items.some((item) => item.caseId === recentCaseId)
            ? <Button type="button" variant="secondary" onClick={() => { setSelectedCaseId(recentCaseId); setCheckMessage(""); }}>최근 확인 결과 보기</Button> : null}
          {cases.error && !permissionLost ? <div role="alert" className="grid gap-2"><Text tone="danger">확인 필요 목록을 조회하지 못했습니다. 제어 잠금은 유지됩니다.</Text><Button type="button" variant="secondary" onClick={() => void cases.refetch()}>case 다시 조회</Button></div> : null}
        </div>
        {selectedCaseId ? <div className="grid gap-2 border-t border-border-default pt-3">
          {detail.isPending ? <Text role="status">case 상세를 조회하는 중입니다.</Text> : null}
          {detail.error && !permissionLost ? <div role="alert" className="grid gap-2"><Text tone="danger">case 상세를 확인하지 못했습니다. 잠금은 유지됩니다.</Text><Button type="button" variant="secondary" onClick={() => void detail.refetch()}>상세 다시 조회</Button></div> : null}
          {blockedCase?.caseId === selectedCaseId && !detail.error ? <Button type="button" variant="secondary" disabled={detail.isFetching} onClick={() => void detail.refetch()}>case 다시 조회</Button> : null}
          {selectedCase ? <>
            <Text>영향 조명 {selectedCase.targetCount}개 · 확인 시도 {selectedCase.verificationAttemptCount}회</Text>
            <Text variant="caption" tone="secondary">대상 ID: {selectedCase.targetFixtureIds.join(", ")}</Text>
            {canCheck || retryCheck?.responseLost && retryCheck.caseId === selectedCase.caseId ? <Button type="button" variant="secondary" disabled={checking} onClick={() => void requestStatusCheck()}>{retryCheck?.responseLost ? "동일 상태 확인 요청 재시도" : "실제 상태 확인 요청"}</Button> : null}
            {canManage ? <Button type="button" variant="secondary" onClick={() => setRiskOpen(true)}>위험 승인</Button> : null}
          </> : null}
          {resolvedCase ? <div role="status" className="grid gap-2">
            <Text as="strong">{resolvedCase.status === "verified_applied" ? "실제 상태 확인: 적용됨"
              : resolvedCase.status === "verified_not_applied" ? "실제 상태 확인: 미적용"
                : "실제 상태 확인: 일부 적용"}</Text>
            <Text>영향 조명 {resolvedCase.targetCount}개 · 확인 시각 {formatControlTimestamp(resolvedCase.resolvedAt, timeZone)} ({timeZone})</Text>
            {resolvedCase.status !== "verified_applied" ? <Text tone="warning">이 결과로 자동 재적용하지 않습니다. 필요한 경우 수동 화면에서 새 제어를 명시적으로 적용하세요.</Text> : null}
          </div> : null}
          {checkMessage ? <Text role="status" tone="warning">{checkMessage}</Text> : null}
        </div> : null}
      </div>
    </DrawerDialog>
    {selectedCase && canManage ? <CommandRiskReconcileDialog key={`${userId}:${siteId}:${selectedCase.caseId}`} open={riskOpen} caseRecord={selectedCase} timeZone={timeZone} onClose={() => setRiskOpen(false)} onSubmit={reconcile} /> : null}
  </>;
}

function CaseRow({ item, selected, onSelect }: { item: CommandVerificationCase; selected: boolean; onSelect: () => void }) {
  const reason = item.reasonCode === "outcome_unknown" ? "결과 불확실" : item.reasonCode === "attempts_exhausted" ? "확인 시도 소진" : "게이트웨이 연결 불가";
  return <Button type="button" variant="secondary" className="grid h-auto min-h-11 w-full justify-items-start gap-1 text-left" aria-pressed={selected} onClick={onSelect}>
    <span className="font-semibold">{item.originalCommandId}</span>
    <span>{reason} · {item.targetCount}개 조명</span>
  </Button>;
}
