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
    <Card className="command-history-panel" aria-label="최근 명령 이력">
      <h3>최근 명령 이력</h3>
      <div className="command-history-filters">
        <label className="form-field"><span>명령 검색</span><input type="search" aria-label="명령 이력 검색" placeholder="명령 ID 또는 조명 이름" maxLength={100} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label className="form-field"><span>상태</span><select aria-label="명령 상태 필터" value={stage} onChange={(event) => setStage(event.target.value as CommandStage | "")}>
          <option value="">전체 상태</option>
          {Object.entries(COMMAND_STAGE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
      </div>
      <div className="command-history-list" aria-label="명령 이력 목록">
        {history.isPending ? <p role="status">명령 이력을 불러오는 중입니다.</p> : null}
        {!history.isPending && !history.error && items.length === 0 ? <p>명령 이력이 없습니다.</p> : null}
        {items.map((item) => <Button key={item.id} variant="secondary" type="button" className="command-history-row" disabled={disabled} aria-pressed={selectedCommandId === item.id} onClick={() => onSelect(item.id)}>
          <span className="command-history-identity">{item.id}</span>
          <span>{item.brightness ?? "—"}% · {item.totalFixtureCount}개 조명{item.createdAt ? ` · ${new Date(item.createdAt).toLocaleString("ko-KR")}` : ""}</span>
          <StatusBadge tone={item.stage === "verification_required" ? "warning" : "neutral"} icon={item.stage === "verification_required" ? TriangleAlert : Clock3}>{COMMAND_STAGE_LABELS[item.stage]}</StatusBadge>
        </Button>)}
        {history.error ? <div role="alert"><p>명령 이력을 불러오지 못했습니다.</p><Button variant="secondary" type="button" disabled={history.isFetching} onClick={() => void (history.isFetchNextPageError ? history.fetchNextPage() : history.refetch())}>이력 다시 조회</Button></div> : null}
        {history.hasNextPage ? <Button variant="secondary" type="button" disabled={history.isFetching} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? "이력 불러오는 중" : "더 보기"}</Button> : null}
      </div>
    </Card>
  );
}
import { Clock3, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useCommandHistory, type CommandStage } from "../../api/commands";
import { Button, Card, StatusBadge } from "../../components/ui";

export const COMMAND_STAGE_LABELS: Record<CommandStage, string> = {
  queued: "명령 접수 완료", published: "게이트웨이 전송 완료", accepted: "게이트웨이 수신 완료",
  completed: "조명 적용 완료", partial_failed: "일부 조명 적용 실패", failed: "명령 처리 실패", timed_out: "명령 응답 시간 초과",
  verification_required: "실제 상태 확인 필요", verified_applied: "적용 확인", verified_not_applied: "미적용 확인", verified_partial: "일부 적용 확인"
};
