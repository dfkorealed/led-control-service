export function RfPlanningPanel() {
  return (
    <section className="panel">
      <h2>통신 음영 검토</h2>
      <p>1차 RF 검토 도구는 Hamina Planner를 사용합니다.</p>
      <ul className="compact-list">
        <li>입력: 주차장 도면, 층별 scale, 벽/기둥/램프 구조</li>
        <li>MVP 1 산출물: 예상 음영 후보와 권장 보강 위치</li>
        <li>MVP 2 지표: RSSI, hop count, 명령 성공률, 응답 지연</li>
      </ul>
    </section>
  );
}
