import type { TemporaryControlView } from "@led-control/shared/temporary-control-contracts";
import { Button, Heading, Text } from "../../components/ui";
import { temporaryControlStateLabels } from "../../api/temporary-controls";
import { formatControlTimestamp } from "./control-time";
export interface TemporaryControlHistoryProps { session: TemporaryControlView; onClose(): void; timeZone?: string }
export function TemporaryControlHistory({ session, onClose, timeZone = "UTC" }: TemporaryControlHistoryProps) {
  return <section aria-label="시간제 상세" className="grid min-h-0 min-w-0 gap-3 overflow-y-auto overscroll-contain">
    <Heading as="h3" variant="card-title">시간제 제어 상세</Heading>
    <Text>{temporaryControlStateLabels[session.state]}</Text>
    <Text variant="caption" className="break-all">{session.id}</Text>
    <Text>시작 {formatControlTimestamp(session.startedAt, timeZone)} · 종료 {formatControlTimestamp(session.endsAt, timeZone)}</Text>
    {session.detailsRedacted ? <Text>상세 보관 종료. 원래 세션의 상태만 표시합니다.</Text> : <>
      <Text>{session.targets.length}개 조명 · {session.brightness}%</Text>
      {session.targets.map(target => <section key={target.fixtureId} className="grid min-w-0 gap-1 border-t border-border-default pt-2" aria-label={`조명 결과 ${target.fixtureId}`}>
        <Text className="break-all" variant="caption">{target.fixtureId}</Text>
        {session.results.filter(result => result.fixtureId === target.fixtureId).map(result => <div key={result.eventId} className="grid min-w-0 gap-1">
          <Text variant="caption">{result.kind === "apply" ? "적용" : result.kind === "release" ? "복귀" : "관측"} 기록 · {formatControlTimestamp(result.observedAt, timeZone)}</Text>
          <Text variant="caption">적용 {result.applyConfirmed ? "확인" : "미확인"} · 복귀 {result.releaseConfirmed ? "확인" : "미확인"}</Text>
          {result.configurationMayHaveChanged && !result.releaseConfirmed ? <Text variant="caption" tone="warning">설정 변경 가능 · {result.partialMutation === "high_brightness" ? "밝기 설정 일부 변경" : result.partialMutation === "mode" ? "모드 일부 변경" : result.partialMutation === "unverified" ? "변경 범위 미확인" : "전체 설정 관측"}</Text> : null}
          {result.configurationReadback ? <Text variant="caption">설정 밝기 {result.configurationReadback.configuredHighBrightnessPercent}% · 모드 {result.configurationReadback.bioMode} · 해당 기록의 설정 관측</Text> : null}
          {result.reason ? <Text tone="danger" className="break-words">{result.reason}</Text> : null}
        </div>)}
        {!session.results.some(result => result.fixtureId === target.fixtureId) ? <Text variant="caption">조명 보고 대기</Text> : null}
      </section>)}
    </>}
    {session.reason ? <Text tone="danger">{session.reason}</Text> : null}
    <Button type="button" variant="secondary" onClick={onClose}>시간제 상세 닫기</Button>
  </section>;
}
