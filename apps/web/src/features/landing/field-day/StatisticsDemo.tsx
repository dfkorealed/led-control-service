import { DemoCard, type SceneMotion } from "./Scene";

const line = "M0 161 C42 145 60 158 103 131 S162 112 207 123 S264 163 310 140 S370 85 413 91 S471 121 517 105 S576 65 620 78";

export function StatisticsDemo({ motion }: { motion: SceneMotion }) {
  return <DemoCard title="통계" detail="기간별 추정 전력" name="추정 전력 그래프 애니메이션 예시"
    disclaimer="이 그래프는 가상 값으로 만든 상태 기반 추정치입니다. 실측 전력이 아닙니다." motion={motion} className="chart-demo">
    <div className="chart-content">
      <div className="chart-heading"><div><span>예시 현장 · 이번 주</span><strong>상태 기반 추정 전력</strong></div><span className="chart-unit">단위: kWh · 추정치</span></div>
      <div className="chart-frame">
        <div className="chart-y" aria-hidden="true">{[80, 60, 40, 20, 0].map(value => <span key={value}>{value}</span>)}</div>
        <svg className="chart-svg" viewBox="0 0 620 240" preserveAspectRatio="none" role="img" aria-label="월요일부터 일요일까지 추정 전력이 오르내리는 설명용 선 그래프">
          <g className="chart-grid" aria-hidden="true"><path d="M0 20H620M0 70H620M0 120H620M0 170H620M0 220H620" /></g>
          <path className="chart-area" d={`${line} V220 H0Z`} />
          <path className="chart-line" d={line} pathLength="100" />
          <g className="chart-points" aria-hidden="true">{[[0,161],[103,131],[207,123],[310,140],[413,91],[517,105],[620,78]].map(([x,y]) => <circle key={x} cx={x} cy={y} r="5" />)}</g>
        </svg>
        <div className="chart-x" aria-hidden="true">{"월화수목금토일".split("").map(day => <span key={day}>{day}</span>)}</div>
      </div>
      <div className="chart-foot"><span><i />추정 전력</span><span>상태와 설정값을 바탕으로 계산한 예시</span></div>
      <p className="sr-only" role="status" aria-live="polite">{motion.phase === "playing" ? "설명용 그래프를 그리고 있습니다." : "예시 추정 전력 그래프가 표시됐습니다."}</p>
    </div>
  </DemoCard>;
}
