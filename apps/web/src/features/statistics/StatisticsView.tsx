import { useEnergyEstimate } from "../../api/energy";

export function StatisticsView() {
  const { data, isLoading, error } = useEnergyEstimate();

  if (isLoading) return <section className="panel">전력 통계를 불러오는 중</section>;
  if (error || !data) return <section className="panel danger">전력 통계를 불러오지 못했습니다.</section>;
  const bars = [
    { label: "일", value: data.day.kwh, height: 32 },
    { label: "월", value: data.month.kwh, height: 76 },
    { label: "년", value: data.year.kwh, height: 100 }
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
        <div className="metric success">
          <span>절감 지표</span>
          <strong>18%</strong>
          <small>디밍 정책 기준</small>
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
                <span className="bar" style={{ height: `${bar.height}%` }} />
                <strong>{bar.label}</strong>
                <small>{bar.value} kWh</small>
              </div>
            ))}
          </div>
        </div>
        <aside className="panel insight-panel">
          <span className="eyebrow">운영 인사이트</span>
          <h3>요금 추정</h3>
          <p>현재 밝기 정책 기준 월 예상 전기료는 {data.month.cost.toLocaleString()}원입니다.</p>
          <dl className="info-list">
            <div>
              <dt>피크 시간</dt>
              <dd>18:00-22:00</dd>
            </div>
            <div>
              <dt>추천 정책</dt>
              <dd>야간 60%</dd>
            </div>
          </dl>
        </aside>
      </div>
    </section>
  );
}
