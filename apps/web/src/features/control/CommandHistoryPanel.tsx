import { Clock3, TriangleAlert } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { FocusScope, useFocusManager } from "react-aria";
import { useQueryClient } from "@tanstack/react-query";
import { useCommandHistory, type CommandStage, type CommandStatusResponse } from "../../api/commands";
import { ApiError } from "../../api/client";
import { Button, Card, DateRangePicker, DrawerDialog, FilterPanel, LogView, PageSizeSelect, PaginationBar, RecentActivityTicker, SearchField, SelectBox, StatusBadge, Text, cn, useDateRangeDraft, type DateRangeValue } from "../../components/ui";
import { draftToDate, isEmptyDateDraft } from "../../components/ui/date/useDateDraft";
import { formatControlTimestamp } from "./control-time";

import { commandHistoryRows, COMMAND_STAGE_LABELS, clockRefusalExplanation, isClockRefusal } from "./command-history-presentation";
export { COMMAND_STAGE_LABELS, isClockRefusal } from "./command-history-presentation";

const commandStageItems = [
  { id: "", label: "전체 상태" },
  ...Object.entries(COMMAND_STAGE_LABELS).map(([id, label]) => ({ id, label }))
];

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

const RecentCommandInteraction = createContext<Pick<CommandHistoryPanelProps, "onSelect" | "disabled" | "selectedCommandId"> | null>(null);
type RecentCommandPresentation = { id: string; timestampLabel: string; content: string; status: string };

function RecentCommandButton({ row }: { row: RecentCommandPresentation }) {
  const interaction = useContext(RecentCommandInteraction);
  // A narrow mobile summary keeps its 44px frame: rounded corners can remove
  // part of a continuous pointer square. Square only this inline action's hit
  // shape; retain the desktop/generic corners and ticker/interaction ownership.
  return <Button variant="ghost" type="button" className="min-h-11! min-w-11 max-w-full max-compact:rounded-none justify-start! overflow-hidden px-0! text-left! font-normal!"
    disabled={interaction?.disabled} aria-pressed={interaction?.selectedCommandId === row.id}
    aria-label={`최근 명령 상세: ${row.id} · ${row.timestampLabel} · ${row.content} · ${row.status}`}
    onClick={() => { if (interaction && !interaction.disabled) interaction.onSelect(row.id); }}>
    <span className="truncate"><span className="compact:hidden">{row.status} · </span>{row.content}</span>
  </Button>;
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

  const latest = useCommandHistory(userId, { siteId, limit: 5 });
  const history = useCommandHistory(userId, input, open && !periodError);
  const latestUnauthorized = latest.error instanceof ApiError && [401, 403].includes(latest.error.status);
  const historyUnauthorized = history.error instanceof ApiError && [401, 403].includes(history.error.status);
  const latestItems = latestUnauthorized ? undefined : latest.data?.pages[0]?.items;
  // The retention-filtering hook reconstructs arrays on every render. Compare
  // only the actual visible/accessibility content, never callback/lock identity:
  // unchanged command polling must not restart the shared five-second clock.
  // Undefined fail-closed data still becomes [], and actual expiry/content resets.
  const recentPresentation = JSON.stringify(commandHistoryRows(latestItems ?? [], timeZone).map(row => ({
    id: row.id, timestampLabel: row.timestampLabel, content: String(row.content), status: String(row.status)
  })));
  const tickerRows = useMemo(() => (JSON.parse(recentPresentation) as RecentCommandPresentation[]).map(row => ({ ...row,
    // The one-line mobile row reserves a real 44px command target. Full date,
    // UUID and actual result remain in its accessible name and history dialog.
    timestampLabel: row.timestampLabel.split(" ")[1] ?? row.timestampLabel,
    content: <RecentCommandButton row={row} />,
    status: <span className="hidden max-w-40 truncate compact:block" title={String(row.status)}>{row.status}</span>
  })), [recentPresentation, timeZone]);
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
    <Card className={cn("flex min-h-13 min-w-0 shrink-0 items-center gap-1", compactDisclosure ? "border-0! bg-transparent! p-0!" : "p-3", className)} aria-label="최근 명령 이력" data-command-history-panel="">
      <div className="min-w-0 flex-1">
        <RecentCommandInteraction.Provider value={{ onSelect, disabled, selectedCommandId }}>
          <RecentActivityTicker scopeKey={JSON.stringify([userId, siteId])} items={tickerRows}
            emptyContent={latest.isPending ? <Text role="status">최근 명령을 불러오는 중입니다.</Text>
              : latest.error ? <Text role="alert" tone="danger">최근 명령을 불러오지 못했습니다.</Text>
              : <Text>명령 이력이 없습니다.</Text>}
            onOpen={() => setOpen(true)} triggerRef={openerRef} triggerHasPopup="dialog"
            onRetry={latest.error ? () => void latest.refetch() : undefined} />
        </RecentCommandInteraction.Provider>
      </div>
      {/* Keep uncertain-case recovery reachable independently of history fetching or dimming locks. */}
      {onOpenVerificationCases ? <Button ref={verificationCasesOpenerRef} type="button" variant="ghost" className="min-h-13! min-w-13! px-2!" aria-label="확인 필요한 명령" onClick={onOpenVerificationCases}><TriangleAlert size={16} aria-hidden="true" />{verificationCaseCount ? <span aria-hidden="true">{verificationCaseCount}</span> : null}</Button> : null}
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
