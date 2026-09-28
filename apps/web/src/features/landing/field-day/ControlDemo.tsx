import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { NativeRangeSlider } from "../../../components/ui/fields/NativeRangeSlider";
import { DemoCard, type SceneMotion } from "./Scene";

export function ControlDemo({ motion }: { motion: SceneMotion }) {
  const [brightness, setBrightness] = useState(15);
  const [status, setStatus] = useState("예시 밝기를 조정하고 있습니다.");
  const manual = useRef(false);
  const range = useRef<HTMLInputElement>(null);
  function updateFromRange(value: number) {
    manual.current = true;
    motion.stop();
    setBrightness(value);
    setStatus(`예시 밝기를 ${value}%로 조정했습니다. 적용 버튼을 눌러 보세요.`);
  }
  const previousRun = useRef(motion.run);
  useEffect(() => {
    // Keep the input mounted across replay, including reduced-motion replay.
    if (previousRun.current !== motion.run) { previousRun.current = motion.run; manual.current = false; }
    if (motion.phase === "complete") {
      if (!manual.current) { setBrightness(70); setStatus("예시 밝기 70%를 적용했습니다."); }
      return;
    }
    manual.current = false;
    setBrightness(15);
    setStatus("예시 밝기를 조정하고 있습니다.");
    let frame = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      if (manual.current) return;
      if (start === null) start = now;
      const progress = Math.min(1, (now - start) / 1800);
      const eased = 1 - Math.pow(1 - progress, 3);
      setBrightness(Math.round(15 + 55 * eased));
      if (progress < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [motion.run, motion.phase]);
  const vars = {
    "--glow-opacity": String(brightness / 260),
    "--beam-opacity": String(brightness / 210), "--floor-glow": `${brightness}px`
  } as CSSProperties;
  return <DemoCard title="조명 제어" detail="출입구 그룹" name="밝기 조정 인터랙티브 예시"
    disclaimer="이 화면의 조작은 미리보기에서만 반영됩니다. 실제 장비에 명령을 보내지 않습니다." motion={motion} className="control-demo">
    <div className="control-content grid grid-cols-[minmax(0,1fr)_minmax(220px,.88fr)] min-h-[390px] landing-stack:grid-cols-1" style={vars}>
      <div className="control-visual relative overflow-hidden min-h-[390px] bg-brand-navy landing-stack:min-h-[260px]" aria-hidden="true"><div className="control-visual__glow absolute left-1/2 top-37/100 size-[220px] rounded-landing-ellipse bg-brand-coral opacity-(--glow-opacity) blur-[34px] transform-[translate(-50%,-50%)] landing-stack:top-28/100" /><div className="control-visual__lamp absolute left-1/2 top-16/100 w-[70px] h-[68px] border-8 border-t-0 border-border-default rounded-landing-control-pendant bg-surface-panel transform-[translateX(-50%)] landing-stack:top-6/100"><span className="absolute left-1/2 top-landing-control-pendant-cord-top w-[3px] h-[65px] bg-border-default transform-[translateX(-50%)]" /><span className="control-visual__shade absolute left-1/2 -bottom-4.5 w-[110px] h-[13px] rounded-landing-ellipse bg-surface-panel transform-[translateX(-50%)]" /></div><div className="control-visual__beam absolute left-1/2 top-33/100 size-[300px] bg-action-primary-soft opacity-(--beam-opacity) [clip-path:polygon(41%_0,59%_0,100%_100%,0_100%)] blur-[9px] transform-[translateX(-50%)] landing-stack:top-26/100" /><div className="control-visual__floor absolute -left-20/100 -right-20/100 -bottom-32/100 h-[47%] border border-surface-panel/25 rounded-landing-ellipse bg-action-primary-soft/12 shadow-landing-control-floor-glow" /><span className="control-visual__caption absolute left-5 bottom-landing-control-caption-bottom text-surface-panel text-landing-demo-meta font-[750]">출입구 그룹 · 조명 4개</span></div>
      <Card variant="landingDemoSurface" className="control-panel self-center m-4.5 p-landing-control-panel-inset landing-stack:m-landing-control-panel-stacked-margin">
        <div className="control-panel__heading flex items-center justify-between gap-3 text-landing-control-heading font-extrabold"><span>밝기 조정</span><strong className="text-brand-blue text-landing-control-metric">{brightness}%</strong></div>
        <label className="sr-only" htmlFor="brightness-range">출입구 그룹 밝기</label>
        <NativeRangeSlider className="scroll-mt-landing-anchor-anchor-offset" fillPercentage={brightness} ref={range} id="brightness-range" min="0" max="100" step="1" value={brightness} aria-describedby="brightness-hint"
          onInput={event => updateFromRange(Number(event.currentTarget.value))}
          onChange={event => updateFromRange(Number(event.currentTarget.value))} />
        <div className="range-ends flex justify-between text-status-neutral-foreground text-landing-demo-caption"><span>0%</span><span>100%</span></div>
        <p id="brightness-hint" className="control-hint scroll-mt-landing-anchor-anchor-offset min-h-9 m-landing-control-hint-margin text-content-secondary text-landing-control-hint">슬라이더를 움직여 예시 밝기를 바꿔보세요.</p>
        <Button type="button" variant="landingPlanPrimary" className="w-full" onClick={() => { manual.current = true; motion.stop(); const value = Number(range.current?.value ?? brightness); setBrightness(value); setStatus(`예시 밝기 ${value}%를 적용했습니다.`); }}>밝기 적용 <span aria-hidden="true">→</span></Button>
        <p className="demo-status min-h-4.5 m-0 mt-landing-demo-result-top-space text-brand-blue text-landing-demo-status font-[750]" role="status" aria-live="polite">{status}</p>
      </Card>
    </div>
  </DemoCard>;
}
