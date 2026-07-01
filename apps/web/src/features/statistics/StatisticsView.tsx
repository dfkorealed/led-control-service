const staticEstimate = {
  day: { kwh: 28.8, cost: 4608 },
  month: { kwh: 864, cost: 138240 },
  year: { kwh: 10512, cost: 1681920 }
};

export function StatisticsView() {
  return (
    <section className="panel">
      <h2>전력 사용량</h2>
      <div className="summary-row">
        <div className="metric">
          일 <strong>{staticEstimate.day.kwh} kWh</strong>
          <span>{staticEstimate.day.cost.toLocaleString()}원</span>
        </div>
        <div className="metric">
          월 <strong>{staticEstimate.month.kwh} kWh</strong>
          <span>{staticEstimate.month.cost.toLocaleString()}원</span>
        </div>
        <div className="metric">
          년 <strong>{staticEstimate.year.kwh} kWh</strong>
          <span>{staticEstimate.year.cost.toLocaleString()}원</span>
        </div>
      </div>
    </section>
  );
}
