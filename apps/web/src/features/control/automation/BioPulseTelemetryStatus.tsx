import type { BioPulseTelemetryView } from "../../../api/automation";
import type { DashboardFixture } from "../../../api/queries";
import { Text } from "../../../components/ui";

const reasonLabels: Record<string, string> = {
  qualified: "건강 확인", usb_disconnected: "USB 연결 끊김", identity_changed: "센서 식별 정보 변경",
  liveness_failed: "연결 생존 확인 실패", decoder_failed: "신호 해석 실패", fingerprint_changed: "센서 특성 변경",
  connection_changed: "연결 변경", health_unverified: "건강 미확인", operator_release: "운영자 해제 요청",
  hold_expired: "유지 시간 만료", configuration_changed: "규칙 설정 변경", bio_release_pending: "해제 대기"
};
const resultLabels = { pending: "대기", succeeded: "성공", failed: "실패", timed_out: "시간 초과", superseded: "후속 요청으로 대체" };
const modeLabels = { sensor: "센서", "force-on": "강제 켜짐", "force-off": "강제 꺼짐" };

/** The API aggregates all rules/occurrences for a source. Do not relabel this as
 * this rule's execution, infer expiry, or clear pending from a successful GET.
 * Read directly from each dashboard render so remaps/null discard old evidence. */
export function BioPulseTelemetryStatus({ source, fixtures, timeZone }: {
  source?: DashboardFixture;
  fixtures: DashboardFixture[];
  timeZone: string;
}) {
  const telemetry = source?.bioPulseTelemetry;
  const readback = telemetry?.configurationReadback;
  const name = (id: string) => fixtures.find(fixture => fixture.id === id)?.name ?? "이름 미확인 조명";
  return <div className="grid min-w-0 gap-2 break-words">
    <Text weight="semibold">{source?.name ?? "감지 센서 미확인"} · 센서를 사용하는 전체 규칙의 운영 보고</Text>
    <Text>현장 시간대: {timeZone} · 서버에 저장된 과거 보고이며 현재 상태를 보장하지 않습니다.</Text>
    <Text>마지막 유효 펄스: <EvidenceTime value={telemetry?.lastPulseAt} timeZone={timeZone} /></Text>
    <Text>센서 건강 보고: {telemetry?.health === "healthy" ? "정상 보고" : telemetry?.health === "degraded" ? "장애" : "미확인"} · 사유: {reasonLabel(telemetry?.healthReason)}</Text>
    <Text>장애 시작 시각: <EvidenceTime value={telemetry?.degradedSince} timeZone={timeZone} /></Text>
    {telemetry?.health === "degraded" || telemetry?.degradedSince ? <Text role="alert" tone="danger">센서 장애 보고 · 현장을 확인해 주세요. 신호가 없다는 이유만으로 B의 복원을 판단하지 않습니다.</Text> : null}
    <Text>보고 대상 실행 조명: {telemetry?.targetFixtureIds.length ? telemetry.targetFixtureIds.map(name).join(", ") : "미확인"}</Text>
    <Text>복원 대기: {pendingLabel(telemetry?.restorationPending)} · 복원 사유: {reasonLabel(telemetry?.restorationReason)}</Text>
    <Text>마지막 운영 보고: <EvidenceTime value={telemetry?.lastEventAt} timeZone={timeZone} /> · 서버 수신: <EvidenceTime value={telemetry?.receivedAt} timeZone={timeZone} /></Text>
    {readback?.verification === "configuration_readback" ? <div className="grid min-w-0 gap-2" aria-label="BIO 설정 확인 기록">
      <Text>설정 확인 시각: <EvidenceTime value={readback.occurredAt} timeZone={timeZone} /></Text>
      {readback.results.map(result => <div key={result.fixtureId}>
        <Text>{name(result.fixtureId)} · {readback.phase === "restore" ? "복원" : "적용"} 설정 확인: {resultLabels[result.status]}</Text>
        <Text>설정 밝기: {result.configuration ? `${result.configuration.configuredHighBrightnessPercent}%` : "미확인"} · 설정 모드: {result.configuration ? modeLabels[result.configuration.bioMode] : "미확인"}</Text>
      </div>)}
    </div> : <Text>설정 확인: 미확인</Text>}
    <Text tone="secondary">설정 확인값은 현재 광학 출력·전력·에너지 또는 센서 준비 상태의 증거가 아닙니다. 복원 대기 없음 보고도 광학 복원 성공을 뜻하지 않습니다.</Text>
  </div>;
}

function pendingLabel(value: BioPulseTelemetryView["restorationPending"] | undefined) {
  return value === true ? "대기 중" : value === false ? "대기 없음 보고" : "미확인";
}

function reasonLabel(value: string | null | undefined) {
  return value ? reasonLabels[value] ?? "미확인 사유" : "미확인";
}

function EvidenceTime({ value, timeZone }: { value?: string | null; timeZone: string }) {
  if (!value || !Number.isFinite(Date.parse(value))) return <>미확인</>;
  return <time dateTime={value}>{new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "medium", timeZone }).format(new Date(value))}</time>;
}
