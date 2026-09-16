import { Clock3, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useCommandHistory, type CommandStage } from "../../api/commands";
import { Button, Card, Heading, SearchField, SelectBox, StatusBadge, Text } from "../../components/ui";

export const COMMAND_STAGE_LABELS: Record<CommandStage, string> = {
  queued: "명령 접수 완료", published: "게이트웨이 전송 완료", accepted: "게이트웨이 수신 완료",
  completed: "조명 적용 완료", partial_failed: "일부 조명 적용 실패", failed: "명령 처리 실패", timed_out: "명령 응답 시간 초과",
  verification_required: "실제 상태 확인 필요", verified_applied: "적용 확인", verified_not_applied: "미적용 확인", verified_partial: "일부 적용 확인"
};

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
}

export function CommandHistoryPanel({ userId, siteId, onSelect, disabled = false, selectedCommandId }: CommandHistoryPanelProps) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<CommandStage | "">("");
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const history = useCommandHistory(userId, { siteId, query, ...(stage ? { stage } : {}), limit: 20 });
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Card className="flex h-80 max-h-80 min-h-0 min-w-0 flex-col gap-3 overflow-hidden p-4 tablet:h-40 tablet:max-h-40" aria-label="최근 명령 이력" data-command-history-panel="">
      <Heading as="h3" variant="card-title">최근 명령 이력</Heading>
      <div className="grid grid-cols-2 gap-3 max-compact:grid-cols-1">
        <SearchField label="명령 이력 검색" placeholder="명령 ID 또는 조명 이름" maxLength={100} value={search} onChange={setSearch} />
        <SelectBox
          label="명령 상태 필터"
          items={commandStageItems}
          selectedKey={stage}
          onSelectionChange={(key) => setStage((key ?? "") as CommandStage | "")}
        />
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto overscroll-contain" aria-label="명령 이력 목록" data-command-history-list="">
        {history.isPending ? <Text role="status">명령 이력을 불러오는 중입니다.</Text> : null}
        {!history.isPending && !history.error && items.length === 0 ? <Text>명령 이력이 없습니다.</Text> : null}
        {items.map((item) => <Button key={item.id} variant="secondary" type="button" className="grid h-auto min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] justify-items-start gap-1 px-3 py-2 text-left" disabled={disabled} aria-pressed={selectedCommandId === item.id} onClick={() => onSelect(item.id)}>
          <span className="min-w-0 max-w-full truncate font-semibold">{item.id}</span>
          <span>{item.brightness ?? "—"}% · {item.totalFixtureCount}개 조명{item.createdAt ? ` · ${new Date(item.createdAt).toLocaleString("ko-KR")}` : ""}</span>
          <StatusBadge tone={item.stage === "verification_required" ? "warning" : "neutral"} icon={item.stage === "verification_required" ? TriangleAlert : Clock3}>{COMMAND_STAGE_LABELS[item.stage]}</StatusBadge>
        </Button>)}
        {history.error ? <div className="grid gap-2" role="alert"><Text tone="danger">명령 이력을 불러오지 못했습니다.</Text><Button variant="secondary" type="button" disabled={history.isFetching} onClick={() => void (history.isFetchNextPageError ? history.fetchNextPage() : history.refetch())}>이력 다시 조회</Button></div> : null}
        {history.hasNextPage ? <Button variant="secondary" type="button" disabled={history.isFetching} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? "이력 불러오는 중" : "더 보기"}</Button> : null}
      </div>
    </Card>
  );
}
