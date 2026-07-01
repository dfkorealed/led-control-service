import { useEnergyEstimate } from "../../api/energy";

export function StatisticsView() {
  const { data, isLoading, error } = useEnergyEstimate();

  if (isLoading) return <section className="panel">전력 통계를 불러오는 중</section>;
  if (error || !data) return <section className="panel danger">전력 통계를 불러오지 못했습니다.</section>;

  return (
    <section className="panel">
      <h2>전력 사용량</h2>
      <div className="summary-row">
        <div className="metric">
          일 <strong>{data.day.kwh} kWh</strong>
          <span>{data.day.cost.toLocaleString()}원</span>
        </div>
        <div className="metric">
          월 <strong>{data.month.kwh} kWh</strong>
          <span>{data.month.cost.toLocaleString()}원</span>
        </div>
        <div className="metric">
          년 <strong>{data.year.kwh} kWh</strong>
          <span>{data.year.cost.toLocaleString()}원</span>
        </div>
      </div>
    </section>
  );
}
