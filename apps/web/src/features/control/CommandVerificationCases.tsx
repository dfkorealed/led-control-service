import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  commandReadRevalidation, getCommandVerificationCase, isActiveCommandVerificationCase, isResolvedCommandVerificationCase, useCommandVerificationCases,
  type CommandVerificationCase
} from "../../api/commands";
import { ApiError } from "../../api/client";
import { Button, DrawerDialog, Text } from "../../components/ui";
import { clearPendingCaseStatusCheck, loadPendingCaseStatusCheck, saveRecentResolvedCaseId } from "./active-command-store";
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

export function CommandVerificationCases({ open, siteId, userId, canControl, canManage, onClose, recentCaseId, originalCommandId, returnFocusRef, timeZone = "UTC" }: CommandVerificationCasesProps) {
  const queryClient = useQueryClient();
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [checkMessage, setCheckMessage] = useState("");
  const [authorizationLost, setAuthorizationLost] = useState(false);
  const missingDetailRef = useRef<string | null>(null);
  const paginationGeneration = useRef(0);
  const previousButtonRef = useRef<HTMLButtonElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { paginationGeneration.current += 1; setPageIndex(0); }, [userId, siteId, originalCommandId, open]);
  useEffect(() => {
    setPageIndex(0);
    setSelectedCaseId(null);
    setCheckMessage("");
    missingDetailRef.current = null;
  }, [siteId, userId, originalCommandId]);
  useEffect(() => { setAuthorizationLost(false); }, [siteId, userId]);

  const cases = useCommandVerificationCases(userId, { siteId, ...(originalCommandId ? { originalCommandId } : {}), limit: 4 }, open);
  const listUnauthorized = cases.error instanceof ApiError && [401, 403].includes(cases.error.status);
  const detailQueryKey = ["command-verification-case", userId, siteId, selectedCaseId] as const;
  const detail = useQuery({
    ...commandReadRevalidation,
    queryKey: detailQueryKey,
    queryFn: () => getCommandVerificationCase(selectedCaseId!),
    enabled: open && Boolean(selectedCaseId),
    retry: false,
    refetchInterval: (query) => query.state.data?.status === "verification_in_progress" ? 1000 : false
  });
  const detailUnauthorized = detail.error instanceof ApiError && [401, 403].includes(detail.error.status);
  const permissionLost = listUnauthorized || detailUnauthorized || authorizationLost;
  const page = permissionLost || cases.error || cases.isFetching || cases.isPaused ? undefined : cases.data?.pages[pageIndex];
  // React Query retains a successful detail across background refetch failure.
  // Cached data is display history, never fresh authority for Get or approval.
  const scopedDetail = !permissionLost && !cases.error && !cases.isFetching && !cases.isPaused && !detail.isFetching && !detail.isPaused && detail.isFetchedAfterMount && !detail.error
    && detail.data?.siteId === siteId && detail.data.caseId === selectedCaseId ? detail.data : null;
  const selectedCase = scopedDetail && isActiveCommandVerificationCase(scopedDetail) ? scopedDetail : null;
  const resolvedCase = scopedDetail && isResolvedCommandVerificationCase(scopedDetail) ? scopedDetail : null;
  useEffect(() => {
    if (resolvedCase) saveRecentResolvedCaseId(userId, siteId, resolvedCase.caseId);
  }, [resolvedCase, siteId, userId]);
  useEffect(() => {
    if (!listUnauthorized && !detailUnauthorized) return;
    setAuthorizationLost(true);
    setSelectedCaseId(null);
  }, [listUnauthorized, detailUnauthorized]);
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
          {selectedCase ? <>
            <Text tone="warning">서버 기능 준비 전에는 case 상태 확인 요청과 위험 승인을 사용할 수 없습니다. 제어 잠금은 유지됩니다.</Text>
            <Text>영향 조명 {selectedCase.targetCount}개 · 확인 시도 {selectedCase.verificationAttemptCount}회</Text>
            <Text variant="caption" tone="secondary">대상 ID: {selectedCase.targetFixtureIds.join(", ")}</Text>
            {canControl ? <Button type="button" variant="secondary" disabled title="서버 기능 준비 전에는 사용할 수 없습니다.">실제 상태 확인 요청</Button> : null}
            {canManage ? <Button type="button" variant="secondary" disabled title="서버 기능 준비 전에는 사용할 수 없습니다.">위험 승인</Button> : null}
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
  </>;
}

function CaseRow({ item, selected, onSelect }: { item: CommandVerificationCase; selected: boolean; onSelect: () => void }) {
  const reason = item.reasonCode === "outcome_unknown" ? "결과 불확실" : item.reasonCode === "attempts_exhausted" ? "확인 시도 소진" : "게이트웨이 연결 불가";
  return <Button type="button" variant="secondary" className="grid h-auto min-h-11 w-full justify-items-start gap-1 text-left" aria-pressed={selected} onClick={onSelect}>
    <span className="font-semibold">{item.originalCommandId}</span>
    <span>{reason} · {item.targetCount}개 조명</span>
  </Button>;
}
