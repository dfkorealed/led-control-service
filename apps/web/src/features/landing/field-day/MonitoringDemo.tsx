import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { DemoCard, type SceneMotion } from "./Scene";

const fixtures = [
  { id: "01", name: "출입구 조명 01", location: "출입구 구역" },
  { id: "02", name: "통로 조명 02", location: "중앙 통로" },
  { id: "03", name: "통로 조명 03", location: "중앙 통로" },
  { id: "04", name: "주차 구역 조명 04", location: "주차 구역" }
] as const;

export function MonitoringDemo({ motion }: { motion: SceneMotion }) {
  const [selected, setSelected] = useState<string | null>(null);
  const manual = useRef(false);
  const previousRun = useRef(motion.run);
  useEffect(() => {
    // Replay also resets manual state when reduced motion keeps phase complete.
    if (previousRun.current !== motion.run) { previousRun.current = motion.run; manual.current = false; }
    if (motion.phase === "complete") {
      if (!manual.current) setSelected("02");
      return;
    }
    manual.current = false;
    setSelected(null);
    const first = window.setTimeout(() => setSelected("01"), 1100);
    const second = window.setTimeout(() => setSelected("02"), 2350);
    return () => { window.clearTimeout(first); window.clearTimeout(second); };
    // A new run restarts only the timeline; native controls retain focus.
  }, [motion.run, motion.phase]);
  const active = fixtures.find(fixture => fixture.id === selected);
  return <DemoCard title="현장 모니터링" detail="본관 · 지하 1층" name="조명 선택 인터랙티브 예시"
    disclaimer="설명을 위한 예시 도면과 상태입니다. 실제 현장 데이터가 아닙니다." motion={motion} className="monitoring-demo">
    <div className="monitoring-content grid grid-cols-[minmax(0,1.5fr)_minmax(170px,.62fr)] gap-3 p-5 landing-stack:grid-cols-1 landing-stack:landing-narrow:p-3">
      <div className="floorplan overflow-hidden border border-border-default rounded-landing-floorplan bg-brand-paper" aria-label="예시 주차장 도면에서 조명을 선택할 수 있습니다">
        <div className="floorplan__top flex justify-between gap-3 p-landing-floorplan-caption-inset bg-surface-panel text-landing-demo-caption font-[750]"><span>B1 · 주차장</span><span className="text-brand-blue">출입구 구역</span></div>
        <div className="floorplan__drawing relative h-[clamp(230px,28vw,310px)] overflow-hidden m-2.5 border-2 border-border-default rounded-landing-inset-surface bg-surface-panel landing-narrow:h-[230px]">
          <div className="parking-spaces parking-spaces--top absolute left-5/100 right-5/100 top-0 grid grid-cols-5 gap-landing-parking-spaces-gap h-[31%]" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} className="border-2 border-t-0 border-border-default" />)}</div>
          <div className="parking-spaces parking-spaces--bottom absolute left-5/100 right-5/100 bottom-0 grid grid-cols-5 gap-landing-parking-spaces-gap h-[31%]" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} className="border-2 border-b-0 border-border-default" />)}</div>
          <div className="floorplan__lane absolute left-7/100 right-7/100 top-1/2 border-t-2 border-dashed border-border-default" aria-hidden="true" />
          <span className="floorplan__entry absolute left-39/100 bottom-4/100 p-landing-demo-map-label-inset border border-border-default rounded-landing-floorplan-entry bg-action-primary-soft text-brand-blue text-landing-demo-caption font-extrabold">출입구</span>
          {fixtures.map((fixture, index) => <Button key={fixture.id} variant="landingFixture" className={`fixture fixture--${"abcd"[index]} ${["left-23/100 top-34/100", "left-65/100 top-34/100", "left-31/100 top-68/100", "left-74/100 top-68/100"][index]}`} type="button"
            aria-label={`${fixture.name} 선택`} aria-pressed={selected === fixture.id}
            onClick={() => { manual.current = true; motion.stop(); setSelected(fixture.id); }}><span className="size-3.5 rounded-landing-ellipse border-3 border-brand-blue bg-surface-panel ring-3 ring-surface-panel transition-[transform,background,box-shadow] duration-[220ms] ease-[ease] group-hover:transform-[scale(1.25)] group-hover:bg-brand-coral group-hover:shadow-landing-fixture-highlight group-hover:ring-0 group-aria-pressed:transform-[scale(1.25)] group-aria-pressed:bg-brand-coral group-aria-pressed:shadow-landing-fixture-highlight group-aria-pressed:ring-0" /></Button>)}
          <div key={motion.run} className={`demo-cursor absolute z-5 left-3/100 top-7/100 w-6 h-7 opacity-0 pointer-events-none bg-brand-navy [clip-path:polygon(0_0,0_100%,26%_74%,42%_100%,57%_93%,40%_65%,75%_66%)] drop-shadow-[0_2px_1px_var(--color-surface-panel)] ${motion.phase === "playing" ? "motion-safe:animate-landing-monitoring-cursor" : ""}`} aria-hidden="true" />
        </div>
        <div className="floorplan__legend flex justify-start gap-4.5 p-landing-floorplan-caption-inset border-t border-border-subtle bg-surface-panel text-content-secondary text-landing-demo-caption font-[750] landing-narrow:flex-wrap landing-narrow:gap-1.5"><span className="inline-flex items-center gap-landing-demo-status-label-gap"><i className="size-2 border-2 border-brand-blue rounded-landing-ellipse" />조명 위치</span><span className="inline-flex items-center gap-landing-demo-status-label-gap"><i className="size-2 border-2 border-brand-blue rounded-landing-ellipse bg-brand-coral" />선택한 조명</span></div>
      </div>
      <Card variant="landingDemoSurface" className="inspector flex flex-col items-start px-4 py-5 landing-stack:grid landing-stack:grid-cols-[1fr_auto] landing-stack:gap-landing-inspector-stacked-gap">
        <span className="inspector__label text-status-neutral-foreground text-landing-demo-caption font-[750]">선택한 조명</span><strong className="mt-2.5 text-landing-inspector-heading landing-stack:m-0 landing-stack:col-start-1">{active?.name ?? "조명을 선택하세요"}</strong>
        {active && <><span className="status-pill inline-flex items-center gap-landing-demo-status-label-gap mt-3 p-landing-demo-status-label-inset border border-status-success-border rounded-pill bg-status-success-background text-status-success-foreground text-landing-demo-control-label font-extrabold landing-stack:col-start-2 landing-stack:row-start-1 landing-stack:row-end-3 landing-stack:m-0"><i className="size-[5px] rounded-landing-ellipse bg-status-success-foreground" />연결됨</span><dl className="w-full mt-auto mx-0 mb-3.5 pt-5 landing-stack:col-span-full landing-stack:m-0 landing-stack:p-0"><div className="flex justify-between gap-2 mt-3.5 pt-landing-inspector-property-top-inset border-t border-border-subtle text-landing-demo-caption landing-stack:mt-1.5 landing-stack:pt-2"><dt className="text-content-secondary">최근 확인 상태</dt><dd className="m-0 font-extrabold text-right">켜짐</dd></div><div className="flex justify-between gap-2 mt-3.5 pt-landing-inspector-property-top-inset border-t border-border-subtle text-landing-demo-caption landing-stack:mt-1.5 landing-stack:pt-2"><dt className="text-content-secondary">위치</dt><dd className="m-0 font-extrabold text-right">{active.location}</dd></div></dl></>}
        <p className="demo-status m-0 text-brand-blue text-landing-demo-status font-[750] landing-stack:col-span-full" role="status" aria-live="polite">{active ? `선택한 조명: ${active.name}` : "도면에서 조명을 선택해 보세요."}</p>
      </Card>
    </div>
  </DemoCard>;
}
