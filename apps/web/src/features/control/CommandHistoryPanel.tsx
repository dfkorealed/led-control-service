import { Clock3, TriangleAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { FocusScope, useFocusManager } from "react-aria";
import { useQueryClient } from "@tanstack/react-query";
import { useCommandHistory, type CommandStage, type CommandStatusResponse } from "../../api/commands";
import { ApiError } from "../../api/client";
import { Button, Card, DateRangePicker, DrawerDialog, FilterPanel, Heading, LogView, PageSizeSelect, PaginationBar, SearchField, SelectBox, StatusBadge, Text, cn, useDateRangeDraft, type DateRangeValue } from "../../components/ui";
import { draftToDate, isEmptyDateDraft } from "../../components/ui/date/useDateDraft";
import { formatControlTimestamp } from "./control-time";

export const COMMAND_STAGE_LABELS: Record<CommandStage, string> = {
  queued: "명령 접수 완료", published: "게이트웨이 전송 완료", accepted: "게이트웨이 수신 완료",
  completed: "조명 적용 완료", partial_failed: "일부 조명 적용 실패", failed: "명령 처리 실패", timed_out: "명령 응답 시간 초과",
  verification_required: "실제 상태 확인 필요", verified_applied: "적용 확인", verified_not_applied: "미적용 확인", verified_partial: "일부 적용 확인"
};

const commandStageItems = [
  { id: "", label: "전체 상태" },
  ...Object.entries(COMMAND_STAGE_LABELS).map(([id, label]) => ({ id, label }))
];

const clockRefusalExplanation = "게이트웨이 시각을 확인할 수 없어 조명에 전송하기 전 거부했습니다. 자동 재실행되지 않습니다.";

export function isClockRefusal(item: Omit<CommandStatusResponse, "dispatches">): boolean {
  // History has no dispatch details. The API emits this top-level code only for
  // one exact all-target failed dimming dispatch before RF; require its terminal
  // not-applied outcome as well so unknown/partial results keep verification UI.
  return item.errorCode === "GATEWAY_CLOCK_UNTRUSTED" && item.stage === "failed" && item.outcome === "not_applied";
}

export interface CommandHistoryPanelProps {
  userId: string;
  siteId: string;
  onSelect: (commandId: string) => void;
  disabled?: boolean;
  selectedCommandId?: string | null;
  compactDisclosure?: boolean;
  className?: string;
  onOpenVerificationCases?: () => void;
  verificationCasesOpenerRef?: RefObject<HTMLButtonElement>;
  verificationCaseCount?: number;
  timeZone?: string;
}

export function CommandHistoryPanel({ userId, siteId, onSelect, disabled = false, selectedCommandId, compactDisclosure = false, className, onOpenVerificationCases, verificationCasesOpenerRef, verificationCaseCount, timeZone = "UTC" }: CommandHistoryPanelProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<CommandStage | "">("");
  const [limit, setLimit] = useState<50 | 100 | 500 | 1000>(50);
  const [period, setPeriod] = useState<DateRangeValue | null>(null);
  const periodDraft = useDateRangeDraft(JSON.stringify([userId, siteId]), period);
  const draftStart = draftToDate(periodDraft.draft.start);
  const draftEnd = draftToDate(periodDraft.draft.end);
  const emptyPeriodDraft = isEmptyDateDraft(periodDraft.draft.start) && isEmptyDateDraft(periodDraft.draft.end);
  const periodError = !emptyPeriodDraft && (!draftStart || !draftEnd || draftStart > draftEnd)
    ? "시작일과 종료일을 올바른 순서로 완성해 주세요." : "";
  function resetFilters() {
    setPeriod(null); periodDraft.reset(null); setStage(""); setLimit(50);
  }
  const input = { siteId, query, ...(stage ? { stage } : {}), limit, fromDate: period?.start, toDate: period?.end };
  const scopeKey = JSON.stringify([userId, input, open]);
  const [navigation, setNavigation] = useState({ scopeKey, index: 0 });
  // Guard the first render and discard navigation across scopes, including A→B→A.
  const pageIndex = navigation.scopeKey === scopeKey ? navigation.index : 0;
  const setPageIndex = (index: number) => setNavigation({ scopeKey, index });
  const openerRef = useRef<HTMLButtonElement>(null);
  const cursorResetRef = useRef(false);
  const paginationGeneration = useRef(0);
  const queryClient = useQueryClient();
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  useLayoutEffect(() => {
    paginationGeneration.current += 1;
    setNavigation(current => current.scopeKey === scopeKey ? current : { scopeKey, index: 0 });
  }, [scopeKey]);

  const latest = useCommandHistory(userId, { siteId, limit: 1 });
  const history = useCommandHistory(userId, input, open && !periodError);
  const latestUnauthorized = latest.error instanceof ApiError && [401, 403].includes(latest.error.status);
  const historyUnauthorized = history.error instanceof ApiError && [401, 403].includes(history.error.status);
  const latestItem = latestUnauthorized ? undefined : latest.data?.pages[0]?.items[0];
  const page = historyUnauthorized ? undefined : history.data?.pages[pageIndex];
  const pending = history.isPending || history.isFetching || history.isPaused;
  const canRetryHistory = !pending && !periodError;
  function retryHistory() {
    // Explicit refetch ignores the query's enabled flag. The same raw-period
    // validity must guard both the visible retry and this manual request path.
    if (!canRetryHistory) return;
    void history.refetch();
  }
  const success = !periodError && !pending && !history.error && Boolean(page);
  const retainedFrom = (historyUnauthorized ? undefined : history.data?.pages[0]?.retainedFrom)
    ?? (latestUnauthorized ? undefined : latest.data?.pages[0]?.retainedFrom);
  const cursorExpired = history.error instanceof ApiError && history.error.status === 400
    && typeof history.error.body === "object" && history.error.body !== null
    && "code" in history.error.body && history.error.body.code === "command_history_cursor_expired";

  useEffect(() => {
    if (!cursorExpired) { cursorResetRef.current = false; return; }
    if (cursorResetRef.current) return;
    cursorResetRef.current = true;
    // A cursor can cross the retention boundary while the drawer is open.
    // Start a fresh read rather than retaining a stale page as current.
    setPageIndex(0);
    void queryClient.resetQueries({ queryKey: ["command-history", userId, input], exact: true });
  }, [cursorExpired, queryClient, scopeKey]);

  return <>
    <Card className={cn(compactDisclosure
      ? "grid min-h-0 min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0 overflow-hidden px-3 py-1.5 compact:grid-cols-[auto_minmax(0,1fr)_auto]"
      : "flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden p-4", className)} aria-label="최근 명령 이력" data-command-history-panel="">
      {compactDisclosure ? <>
        <Heading as="h3" variant="card-title" className="whitespace-nowrap text-label!">최근 이력</Heading>
        <div className="min-w-0">
          {latest.isPending ? <Text role="status" variant="caption" className="truncate">불러오는 중</Text> : null}
          {latest.error ? <div className="flex min-w-0 items-center gap-1" role="alert"><Text tone="danger" variant="caption" className="truncate">조회 실패</Text><Button variant="ghost" type="button" className="min-h-11! px-1!" onClick={() => void latest.refetch()}>최근 명령 다시 조회</Button></div> : null}
          {!latest.isPending && !latest.error && !latestItem ? <Text variant="caption" className="truncate">명령 이력이 없습니다.</Text> : null}
          {latestItem ? <CompactCommandSummary item={latestItem} selected={selectedCommandId === latestItem.id} disabled={disabled} timeZone={timeZone} onSelect={onSelect} /> : null}
        </div>
        <div className="col-span-2 flex shrink-0 items-center justify-self-end gap-1 compact:col-span-1">
          {/* Rounded corners reduce the reachable area: 52px keeps a full 44px touch target inside. */}
          {onOpenVerificationCases ? <Button ref={verificationCasesOpenerRef} type="button" variant="ghost" className="min-h-13! min-w-13! px-2!" aria-label="확인 필요한 명령" onClick={onOpenVerificationCases}><TriangleAlert size={16} aria-hidden="true" />{verificationCaseCount ? <span aria-hidden="true">{verificationCaseCount}</span> : null}</Button> : null}
          <Button ref={openerRef} type="button" variant="ghost" className="min-h-13! px-2!" aria-label="명령 이력 열기" aria-haspopup="dialog" onClick={() => setOpen(true)}>펼치기</Button>
        </div>
      </> : <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Heading as="h3" variant="card-title">최근 명령 이력</Heading>
          <div className="flex flex-wrap gap-2">
            {onOpenVerificationCases ? <Button ref={verificationCasesOpenerRef} type="button" variant="secondary" aria-label="확인 필요한 명령" onClick={onOpenVerificationCases}>확인 필요한 명령{verificationCaseCount ? <span aria-hidden="true"> {verificationCaseCount}건</span> : null}</Button> : null}
            <Button ref={openerRef} type="button" variant="ghost" aria-haspopup="dialog" onClick={() => setOpen(true)}>명령 이력 열기</Button>
          </div>
        </div>
        {latest.isPending ? <Text role="status">최근 명령을 불러오는 중입니다.</Text> : null}
        {latest.error ? <div className="grid gap-2" role="alert"><Text tone="danger">최근 명령을 불러오지 못했습니다.</Text><Button variant="secondary" type="button" onClick={() => void latest.refetch()}>최근 명령 다시 조회</Button></div> : null}
        {!latest.isPending && !latest.error && !latestItem ? <Text>명령 이력이 없습니다.</Text> : null}
        {latestItem ? <CommandRow item={latestItem} selected={selectedCommandId === latestItem.id} disabled={disabled} timeZone={timeZone} onSelect={onSelect} /> : null}
        <Text variant="caption" tone="secondary">{retainedFrom ? `최근 3개월 이력 · ${formatControlTimestamp(retainedFrom, timeZone)} (${timeZone})부터` : "이력 보관 기간을 확인할 수 없습니다."}</Text>
      </>}
    </Card>
    <DrawerDialog isOpen={open} safeArea title="명령 이력" description="현장의 최근 명령을 조회합니다." closeLabel="명령 이력 닫기" onClose={() => setOpen(false)} returnFocusRef={openerRef}
      className="flex min-h-0 max-w-status-drawer flex-col overflow-hidden" bodyClassName="min-h-0 flex-1 overflow-hidden">
      <LogView label="명령 이력" filters={<FilterPanel label="명령 이력 필터" mode="popover"
        search={<SearchField label={<span className="sr-only">명령 이력 검색</span>} placeholder="명령 ID 또는 조명 이름" maxLength={100} value={search} onChange={setSearch} />}
        activeFilterCount={Number(!emptyPeriodDraft) + Number(Boolean(stage)) + Number(limit !== 50)}
        summary={<Text variant="caption" tone={periodError ? "danger" : "secondary"}>{periodError || (period ? `${period.start} ~ ${period.end} · 종료일 포함` : "전체 보관 기간 · 최근 3개월")} · {stage ? COMMAND_STAGE_LABELS[stage] : "전체 상태"} · 페이지당 {limit}개</Text>}
        filterReset={<Button variant="secondary" type="button" onClick={resetFilters}>필터 초기화</Button>}>
        <DateRangePicker label="조회 기간" value={period} onChange={setPeriod} draftController={periodDraft}
          isInvalid={Boolean(periodError)} errorMessage={periodError} description={period ? `${period.start} ~ ${period.end} · 종료일 포함` : "전체 보관 기간 · 최근 3개월"} />
          <SelectBox label={<span className="sr-only">명령 상태 필터</span>} items={commandStageItems} selectedKey={stage} onSelectionChange={(key) => setStage((key ?? "") as CommandStage | "")} />
          <PageSizeSelect value={limit} options={[50, 100, 500, 1000] as const} onChange={setLimit} />
      </FilterPanel>} pagination={<FocusScope><CommandHistoryPager open={open} scopeKey={JSON.stringify([userId, siteId, open])} pending={pending} success={success} error={history.error}>
        {preserveFocus => <PaginationBar mode="cursor" page={pageIndex + 1} pageSize={limit} pageSizeOptions={[50, 100, 500, 1000] as const}
          showPageSizeSelector={false}
          className="phone-wide:flex-row phone-wide:items-end [&>[data-field]]:phone-wide:w-28 [&>[data-field]]:phone-wide:shrink-0"
          itemCount={success ? page!.items.length : null} isPending={pending} hasPrevious={pageIndex > 0} hasNext={success && Boolean(page?.nextCursor)}
          onPrevious={() => { preserveFocus(); setPageIndex(pageIndex - 1); }}
          onNext={() => {
            preserveFocus();
            const generation = paginationGeneration.current;
            const nextIndex = pageIndex + 1;
            if (history.data?.pages[nextIndex]) { setPageIndex(nextIndex); return; }
            void history.fetchNextPage().then(result => {
              if (paginationGeneration.current === generation && !result.isError && result.data?.pages[nextIndex]) setPageIndex(nextIndex);
            });
          }}
          onPageSizeChange={value => { preserveFocus(); setLimit(value); }} />}
      </CommandHistoryPager></FocusScope>} status={<>
        <Text variant="caption" tone="secondary">{retainedFrom ? `최근 3개월 · ${formatControlTimestamp(retainedFrom, timeZone)} (${timeZone})부터` : "이력 보관 기간을 확인할 수 없습니다."}</Text>
        {pending ? <Text role="status">명령 이력을 불러오는 중입니다.</Text> : null}
        {success && !page!.items.length ? <Text>{query || stage || period ? "조건에 맞는 명령이 없습니다." : "명령 이력이 없습니다."}</Text> : null}
        {history.error ? <div className="grid gap-2" role="alert"><Text tone="danger">{cursorExpired ? "이력 범위가 변경되었습니다. 첫 페이지를 다시 조회합니다." : "명령 이력을 불러오지 못했습니다."}</Text><Button variant="secondary" type="button" disabled={!canRetryHistory} onClick={retryHistory}>이력 다시 조회</Button></div> : null}
      </>}>
        <div className="grid content-start gap-2" aria-label="명령 이력 목록" data-command-history-list="">
          {success ? page!.items.map(item => <CommandRow key={item.id} item={item} selected={selectedCommandId === item.id} disabled={disabled} timeZone={timeZone} onSelect={id => { onSelect(id); setOpen(false); }} />) : null}
        </div>
      </LogView>
    </DrawerDialog>
  </>;
}

function CompactCommandSummary({ item, selected, disabled, timeZone, onSelect }: { item: Omit<CommandStatusResponse, "dispatches">; selected: boolean; disabled: boolean; timeZone: string; onSelect: (id: string) => void }) {
  const time = item.createdAt ? formatControlTimestamp(item.createdAt, timeZone) : "시각 미확인";
  const refusal = isClockRefusal(item);
  const summary = refusal
    ? `시각 확인 실패 · 조명 전송 전 거부 · ${time} · ${item.totalFixtureCount}개 · ${item.brightness ?? "—"}%`
    : `${time} · ${item.totalFixtureCount}개 · ${item.brightness ?? "—"}% · ${COMMAND_STAGE_LABELS[item.stage]}`;
  return <Button variant="ghost" type="button" className="min-h-11! w-full min-w-0 justify-start! overflow-hidden border-0! bg-transparent! px-0! text-left! text-caption! font-normal!" disabled={disabled} aria-pressed={selected} aria-label={`최근 명령 상세: ${item.id} · ${time} · ${item.totalFixtureCount}개 조명 · 밝기 ${item.brightness ?? "—"}% · ${refusal ? clockRefusalExplanation : COMMAND_STAGE_LABELS[item.stage]}`} onClick={() => onSelect(item.id)}>
    <span className="block min-w-0 truncate max-compact:line-clamp-2 max-compact:whitespace-normal">{summary}</span>
  </Button>;
}

function CommandRow({ item, selected, disabled, timeZone, onSelect }: { item: Omit<CommandStatusResponse, "dispatches">; selected: boolean; disabled: boolean; timeZone: string; onSelect: (id: string) => void }) {
  return <Button variant="secondary" type="button" className="grid h-auto min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] justify-items-start gap-1 px-3 py-2 text-left" disabled={disabled} aria-pressed={selected} onClick={() => onSelect(item.id)}>
    <span className="col-span-2 min-w-0 max-w-full truncate font-semibold">{item.id}</span>
    <span className="col-span-2 whitespace-normal break-words">{item.brightness ?? "—"}% · {item.totalFixtureCount}개 조명{item.createdAt ? ` · ${formatControlTimestamp(item.createdAt, timeZone)}` : ""}</span>
    <StatusBadge tone={item.stage === "verification_required" ? "warning" : "neutral"} icon={item.stage === "verification_required" ? TriangleAlert : Clock3}>{COMMAND_STAGE_LABELS[item.stage]}</StatusBadge>
    {isClockRefusal(item) ? <Text as="span" variant="caption" tone="danger" className="col-span-2 text-left">{clockRefusalExplanation}</Text> : null}
  </Button>;
}

function CommandHistoryPager({ open, scopeKey, pending, success, error, children }: {
  open: boolean; scopeKey: string; pending: boolean; success: boolean; error: unknown;
  children: (preserveFocus: () => void) => ReactNode;
}) {
  const pagerRef = useRef<HTMLDivElement>(null);
  const lease = useRef<{ scopeKey: string; control: HTMLButtonElement } | null>(null);
  const focusManager = useFocusManager();
  function preserveFocus() {
    const pager = pagerRef.current;
    const intent = lease.current;
    if (intent?.scopeKey === scopeKey && pager && intent.control.isConnected) pager.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    function restore() {
      const intent = lease.current;
      const pager = pagerRef.current;
      if (!open || intent?.scopeKey !== scopeKey) { lease.current = null; return; }
      if (!pager || !intent.control.isConnected) return;
      const active = document.activeElement;
      const dialog = pager.closest('[role="dialog"]');
      if (active && active !== document.body && active !== dialog && !pager.contains(active)) return;
      if (pending) pager.focus({ preventScroll: true });
      else if (!intent.control.disabled) intent.control.focus({ preventScroll: true });
      else if (!focusManager?.focusFirst({ tabbable: true })) pager.focus({ preventScroll: true });
    }
    restore();
    // SelectBox closes its portal after the layout pass. Recheck the live lease,
    // without overriding a deliberate move to dates, body, or the close action.
    const frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [open, scopeKey, pending, success, error, focusManager]);
  return <div ref={pagerRef} role="group" aria-label="명령 이력 페이지 조작" aria-busy={pending || undefined} tabIndex={-1}
    onFocusCapture={event => { if (event.target instanceof HTMLButtonElement && event.currentTarget.contains(event.target)) lease.current = { scopeKey, control: event.target }; }}
    onBlurCapture={event => {
      const next = event.relatedTarget;
      if (next instanceof Element && !event.currentTarget.contains(next) && !next.closest('[role="listbox"]') &&
        !(event.target instanceof Element && event.target.closest('[role="listbox"]') && next.getAttribute("role") === "dialog")) lease.current = null;
    }}>{children(preserveFocus)}</div>;
}
