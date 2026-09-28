import { DemoCard, type SceneMotion } from "./Scene";

const line = "M0 161 C42 145 60 158 103 131 S162 112 207 123 S264 163 310 140 S370 85 413 91 S471 121 517 105 S576 65 620 78";

export function StatisticsDemo({ motion }: { motion: SceneMotion }) {
  return <DemoCard title="통계" detail="기간별 추정 전력" name="추정 전력 그래프 애니메이션 예시"
    disclaimer="이 그래프는 가상 값으로 만든 상태 기반 추정치입니다. 실측 전력이 아닙니다." motion={motion} className="chart-demo">
    <div className="chart-content p-landing-chart-content-inset landing-narrow:px-3.5 landing-narrow:py-5">
      <div className="chart-heading flex items-end justify-between gap-landing-chart-heading-gap"><div><span className="block mb-2 text-content-secondary text-landing-demo-caption font-[750]">예시 현장 · 이번 주</span><strong className="text-landing-chart-heading landing-narrow:text-landing-chart-heading-narrow">상태 기반 추정 전력</strong></div><span className="chart-unit text-status-neutral-foreground text-landing-demo-caption landing-narrow:hidden">단위: kWh · 추정치</span></div>
      <div className="chart-frame relative mt-landing-chart-frame-top-space p-landing-chart-frame-inset">
        <div className="chart-y absolute top-landing-chart-axis-top bottom-landing-chart-axis-bottom left-0 flex flex-col justify-between text-status-neutral-foreground text-landing-demo-micro" aria-hidden="true">{[80, 60, 40, 20, 0].map(value => <span key={value}>{value}</span>)}</div>
        <svg key={motion.run} className="chart-svg w-full h-[clamp(205px,22vw,260px)] overflow-visible landing-narrow:h-[190px]" viewBox="0 0 620 240" preserveAspectRatio="none" role="img" aria-label="월요일부터 일요일까지 추정 전력이 오르내리는 설명용 선 그래프">
          <g className="chart-grid" aria-hidden="true"><path className="fill-none stroke-chart-grid stroke-1" d="M0 20H620M0 70H620M0 120H620M0 170H620M0 220H620" /></g>
          <path className={`chart-area fill-action-primary-soft motion-reduce:opacity-100 ${motion.phase === "playing" ? "opacity-0 animate-landing-chart-area" : "opacity-100"}`} d={`${line} V220 H0Z`} />
          <path className={`chart-line motion-reduce:[stroke-dashoffset:0] fill-none stroke-brand-blue stroke-4 [stroke-linecap:round] [stroke-linejoin:round] [stroke-dasharray:100] ${motion.phase === "playing" ? "[stroke-dashoffset:100] animate-landing-chart-line" : "[stroke-dashoffset:0]"}`} d={line} pathLength="100" />
          <g className="chart-points" aria-hidden="true">{[[0,161],[103,131],[207,123],[310,140],[413,91],[517,105],[620,78]].map(([x,y]) => <circle className={`motion-reduce:opacity-100 fill-surface-panel stroke-brand-blue stroke-3 ${motion.phase === "playing" ? "opacity-0 animate-landing-chart-points" : "opacity-100"}`} key={x} cx={x} cy={y} r="5" />)}</g>
        </svg>
        <div className="chart-x flex justify-between mt-2.5 text-content-secondary text-landing-demo-caption" aria-hidden="true">{"월화수목금토일".split("").map(day => <span key={day}>{day}</span>)}</div>
      </div>
      <div className="chart-foot flex items-center justify-between gap-2.5 mt-landing-chart-footer-top-space pt-4.5 border-t border-border-subtle text-content-secondary text-landing-demo-caption"><span className="inline-flex items-center gap-landing-chart-legend-gap text-brand-navy font-extrabold"><i className="size-[9px] rounded-landing-ellipse bg-brand-blue" />추정 전력</span><span className="landing-narrow:hidden">상태와 설정값을 바탕으로 계산한 예시</span></div>
      <p className="sr-only" role="status" aria-live="polite">{motion.phase === "playing" ? "설명용 그래프를 그리고 있습니다." : "예시 추정 전력 그래프가 표시됐습니다."}</p>
    </div>
  </DemoCard>;
}
