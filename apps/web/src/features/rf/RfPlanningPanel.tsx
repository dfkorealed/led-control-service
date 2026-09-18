import { Card, Heading, Text } from "../../components/ui";

export function RfPlanningPanel() {
  return (
    <Card className="grid gap-3.5 p-4">
      <div>
        <Text as="span" variant="overline">RF Planning</Text>
        <Heading as="h3" variant="card-title">통신 음영 검토</Heading>
      </div>
      <Text>1차 RF 검토 도구는 Hamina Planner를 사용합니다.</Text>
      <ul className="m-0 grid list-disc gap-1.5 pl-4.5 text-body-sm text-content-secondary">
        <li>입력: 주차장 도면, 층별 scale, 벽/기둥/램프 구조</li>
        <li>MVP 1 산출물: 예상 음영 후보와 권장 보강 위치</li>
        <li>MVP 2 지표: RSSI, hop count, 명령 성공률, 응답 지연</li>
      </ul>
    </Card>
  );
}
