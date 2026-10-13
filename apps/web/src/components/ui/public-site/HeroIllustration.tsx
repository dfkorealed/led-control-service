import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Activity, BarChart3, SlidersHorizontal } from "lucide-react";
import { Button } from "../Button";
import { Card } from "../Card";

const previews = [
  { label: "모니터링", title: "MONITORING", detail: "위치와 상태를 한눈에", icon: Activity, pin: [26, 24], bars: [35, 62, 49, 80, 67, 88] },
  { label: "제어", title: "CONTROL", detail: "필요한 만큼 밝기 조절", icon: SlidersHorizontal, pin: [58, 31], bars: [70, 70, 70, 70, 70, 70] },
  { label: "통계", title: "STATISTICS", detail: "운영의 변화를 그래프로", icon: BarChart3, pin: [68, 56], bars: [88, 76, 66, 54, 45, 35] }
] as const;

/** All values are visual examples: selecting a preview never controls equipment or calls an API. */
export function HeroIllustration({ isAnimating }: { isAnimating: boolean }) {
  const [selected, setSelected] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const preview = previews[selected];
  const clearDepth = () => {
    stage.current?.style.setProperty("--hero-depth-x", "0px");
    stage.current?.style.setProperty("--hero-depth-y", "0px");
  };
  useEffect(() => { if (!isAnimating) clearDepth(); }, [isAnimating]);
  const moveDepth = (event: PointerEvent<HTMLDivElement>) => {
    // Touch remains native scroll/tap. Imperative CSS variables avoid rendering React on every mouse movement.
    if (!isAnimating || event.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--hero-depth-x", `${((event.clientX - bounds.left) / bounds.width - .5) * 12}px`);
    event.currentTarget.style.setProperty("--hero-depth-y", `${((event.clientY - bounds.top) / bounds.height - .5) * 12}px`);
  };

  return <div className="hero-art relative m-auto w-full max-w-[540px] landing-wide:landing-stack:w-[min(75vw,350px)] landing-wide:landing-stack:landing-narrow:w-[74vw]" data-preview={preview.title}>
    <div ref={stage} className="hero-art__stage relative aspect-square [--hero-depth-x:0px] [--hero-depth-y:0px]" onPointerMove={moveDepth} onPointerLeave={clearDepth} aria-hidden="true">
      <div className={`hero-art__ring absolute inset-2/100 rounded-landing-ellipse border border-surface-panel/18 bg-radial-[circle_at_42%_38%_in_srgb] from-action-primary-soft via-brand-blue via-65% to-brand-navy to-98% shadow-landing-hero-atmosphere ${isAnimating ? "motion-safe:animate-landing-hero-ring" : ""}`} />
      <Card variant="landingGlass" className="hero-art__panel hero-art__panel--back absolute top-17/100 -right-2/100 min-h-[33%] w-[43%] transform-[translate(var(--hero-depth-x),var(--hero-depth-y))_rotate(9deg)] bg-surface-panel/14 p-landing-hero-art-background-card-inset motion-safe:transition-transform motion-safe:duration-300 landing-wide:landing-stack:p-landing-hero-art-background-card-stacked-inset">
        <span className="mb-5 block text-landing-hero-art-label font-extrabold text-surface-panel">{preview.title}</span>
        {["w-full", "w-[70%]", "w-[85%]"].map(width => <i key={width} className={`my-3 block h-[9px] rounded-control bg-surface-panel/35 ${width}`} />)}
      </Card>
      <Card variant="landingGlass" className="hero-art__panel hero-art__panel--front absolute bottom-12/100 left-3/100 w-[66%] transform-[translate(calc(var(--hero-depth-x)*-1),calc(var(--hero-depth-y)*-1))_rotate(-5deg)] bg-surface-panel/93 p-landing-hero-art-metric-card-inset text-brand-navy motion-safe:transition-transform motion-safe:duration-300 landing-wide:landing-stack:p-4.5">
        <span className="block text-landing-demo-meta font-extrabold text-brand-blue">하나의 현장</span><strong className="mt-2.5 block text-landing-hero-art-metric">위치 · 제어 · 기록</strong>
        <div className="mt-landing-hero-art-chart-top-space flex h-[80px] items-end justify-between gap-landing-hero-art-chart-gap landing-wide:landing-stack:h-[42px]">
          {preview.bars.map((height, index) => <b key={index} className={`hero-art__bar block flex-1 rounded-landing-hero-chart-bar motion-safe:transition-[height] motion-safe:duration-500 ${index === 3 ? "bg-brand-coral" : index === 0 || index === 2 ? "bg-action-primary-soft" : "bg-brand-blue"} ${isAnimating ? "origin-bottom motion-safe:animate-landing-hero-bars" : ""}`} style={{ height: `${height}%`, animationDelay: `${index * .15}s` }} />)}
        </div>
      </Card>
      <div className="hero-art__pin absolute motion-safe:transition-[top,left] motion-safe:duration-500" style={{ left: `${preview.pin[0]}%`, top: `${preview.pin[1]}%` }}>
        <span key={selected} className={`absolute -inset-3 rounded-landing-ellipse border border-brand-coral/40 ${isAnimating ? "motion-safe:animate-ping motion-safe:[animation-iteration-count:1]" : ""}`} />
        <div className={`hero-art__pulse relative size-[18px] rounded-landing-ellipse border-5 border-surface-panel bg-brand-coral shadow-landing-hero-highlight ${isAnimating ? "motion-safe:animate-landing-hero-dot" : ""}`} />
        <div className={`hero-art__pointer absolute top-6 left-4 h-[30px] w-[25px] bg-surface-panel [clip-path:polygon(0_0,0_100%,26%_74%,44%_100%,59%_92%,42%_64%,75%_66%)] drop-shadow-[0_2px_1px_var(--color-brand-navy)] ${isAnimating ? "motion-safe:animate-landing-hero-pointer" : ""}`} />
      </div>
    </div>
    <div className="hero-art__controls relative z-2 mt-6 flex justify-center gap-2" role="group" aria-label="현장 기능 미리보기">
      {/* The combined state keeps the selected foreground readable while hover is active or retained after touch. */}
      {previews.map(({ label, icon: Icon }, index) => <Button key={label} type="button" variant="landingReportFormat" className="inline-flex min-h-11 items-center justify-center gap-1.5 cursor-pointer rounded-pill border-surface-panel/25 bg-transparent px-3 text-surface-panel hover:enabled:bg-surface-panel/10 aria-pressed:border-brand-coral aria-pressed:bg-brand-coral aria-pressed:hover:enabled:bg-brand-coral aria-pressed:text-brand-navy" aria-label={`${label} 미리보기`} aria-pressed={selected === index} onClick={() => setSelected(index)}><Icon className="size-3.5" aria-hidden="true" /><span>{label}</span></Button>)}
    </div>
    <p className="m-0 mt-3 text-center text-body-sm text-action-primary-soft" aria-live="polite" aria-atomic="true">{preview.detail}</p>
  </div>;
}
