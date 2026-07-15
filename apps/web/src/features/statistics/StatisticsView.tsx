import { useEnergyEstimate } from "../../api/energy";

export function StatisticsView() {
  const { data, isLoading, error } = useEnergyEstimate();

  if (isLoading) return <section className="panel">전력 통계를 불러오는 중</section>;
  if (error || !data) return <section className="panel danger">전력 통계를 불러오지 못했습니다.</section>;
  const values = [data.day.kwh, data.month.kwh, data.year.kwh];
  const maximum = Math.max(...values, 1);
  const bars = [
    { label: "일", value: data.day.kwh },
    { label: "월", value: data.month.kwh },
    { label: "년", value: data.year.kwh }
  ];

  return (
    <section className="statistics-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">전력 통계</span>
          <h2>에너지 리포트</h2>
        </div>
        <span className="status-pill success">추정 집계</span>
      </div>
      <div className="summary-row">
        <div className="metric">
          <span>일 사용량</span>
          <strong>{data.day.kwh} kWh</strong>
          <span>{data.day.cost.toLocaleString()}원</span>
        </div>
        <div className="metric">
          <span>월 사용량</span>
          <strong>{data.month.kwh} kWh</strong>
          <span>{data.month.cost.toLocaleString()}원</span>
        </div>
        <div className="metric">
          <span>년 사용량</span>
          <strong>{data.year.kwh} kWh</strong>
          <span>{data.year.cost.toLocaleString()}원</span>
        </div>
      </div>

      <div className="report-layout">
        <div className="panel chart-panel">
          <div className="panel-title-row">
            <div>
              <span className="eyebrow">사용량 추이</span>
              <h3>기간별 전력 사용량</h3>
            </div>
          </div>
          <div className="bar-chart" aria-label="전력 사용량 막대 차트">
            {bars.map((bar) => (
              <div className="bar-item" key={bar.label}>
                <span className="bar" style={{ height: `${Math.max(4, (bar.value / maximum) * 100)}%` }} />
                <strong>{bar.label}</strong>
                <small>{bar.value} kWh</small>
              </div>
            ))}
          </div>
        </div>
        <aside className="panel insight-panel">
          <span className="eyebrow">예상 요금</span>
          <h3>요금 추정</h3>
          <p>현재 밝기 정책 기준 월 예상 전기료는 {data.month.cost.toLocaleString()}원입니다.</p>
          <p>등록된 정격 전력, 현재 밝기, 일 12시간 점등을 기준으로 계산한 예상치입니다.</p>
        </aside>
      </div>
    </section>
  );
}
