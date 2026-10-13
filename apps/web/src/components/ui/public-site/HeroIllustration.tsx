import { useEffect, useRef, type PointerEvent } from "react";
import { Card } from "../Card";

const illustration = {
  title: "MONITORING",
  pin: [26, 24],
  bars: [35, 62, 49, 80, 67, 88]
} as const;

/** Decorative values illustrate the product; they do not control equipment or call an API. */
export function HeroIllustration({ isAnimating }: { isAnimating: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
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

  return <div className="hero-art relative m-auto w-full max-w-[540px] landing-wide:landing-stack:w-[min(75vw,350px)] landing-wide:landing-stack:landing-narrow:w-[74vw]" data-preview={illustration.title}>
    <div ref={stage} className="hero-art__stage relative aspect-square [--hero-depth-x:0px] [--hero-depth-y:0px]" onPointerMove={moveDepth} onPointerLeave={clearDepth} aria-hidden="true">
      <div className={`hero-art__ring absolute inset-2/100 rounded-landing-ellipse border border-surface-panel/18 bg-radial-[circle_at_42%_38%_in_srgb] from-action-primary-soft via-brand-blue via-65% to-brand-navy to-98% shadow-landing-hero-atmosphere ${isAnimating ? "motion-safe:animate-landing-hero-ring" : ""}`} />
      <Card variant="landingGlass" className="hero-art__panel hero-art__panel--back absolute top-17/100 -right-2/100 min-h-[33%] w-[43%] transform-[translate(var(--hero-depth-x),var(--hero-depth-y))_rotate(9deg)] bg-surface-panel/14 p-landing-hero-art-background-card-inset motion-safe:transition-transform motion-safe:duration-300 landing-wide:landing-stack:p-landing-hero-art-background-card-stacked-inset">
        <span className="mb-5 block text-landing-hero-art-label font-extrabold text-surface-panel">{illustration.title}</span>
        {["w-full", "w-[70%]", "w-[85%]"].map(width => <i key={width} className={`my-3 block h-[9px] rounded-control bg-surface-panel/35 ${width}`} />)}
      </Card>
      <Card variant="landingGlass" className="hero-art__panel hero-art__panel--front absolute bottom-12/100 left-3/100 w-[66%] transform-[translate(calc(var(--hero-depth-x)*-1),calc(var(--hero-depth-y)*-1))_rotate(-5deg)] bg-surface-panel/93 p-landing-hero-art-metric-card-inset text-brand-navy motion-safe:transition-transform motion-safe:duration-300 landing-wide:landing-stack:p-4.5">
        <span className="block text-landing-demo-meta font-extrabold text-brand-blue">하나의 현장</span><strong className="mt-2.5 block text-landing-hero-art-metric">위치 · 제어 · 기록</strong>
        <div className="mt-landing-hero-art-chart-top-space flex h-[80px] items-end justify-between gap-landing-hero-art-chart-gap landing-wide:landing-stack:h-[42px]">
          {illustration.bars.map((height, index) => <b key={index} className={`hero-art__bar block flex-1 rounded-landing-hero-chart-bar motion-safe:transition-[height] motion-safe:duration-500 ${index === 3 ? "bg-brand-coral" : index === 0 || index === 2 ? "bg-action-primary-soft" : "bg-brand-blue"} ${isAnimating ? "origin-bottom motion-safe:animate-landing-hero-bars" : ""}`} style={{ height: `${height}%`, animationDelay: `${index * .15}s` }} />)}
        </div>
      </Card>
      <div className="hero-art__pin absolute motion-safe:transition-[top,left] motion-safe:duration-500" style={{ left: `${illustration.pin[0]}%`, top: `${illustration.pin[1]}%` }}>
        <span className={`absolute -inset-3 rounded-landing-ellipse border border-brand-coral/40 ${isAnimating ? "motion-safe:animate-ping motion-safe:[animation-iteration-count:1]" : ""}`} />
        <div className={`hero-art__pulse relative size-[18px] rounded-landing-ellipse border-5 border-surface-panel bg-brand-coral shadow-landing-hero-highlight ${isAnimating ? "motion-safe:animate-landing-hero-dot" : ""}`} />
        <div className={`hero-art__pointer absolute top-6 left-4 h-[30px] w-[25px] bg-surface-panel [clip-path:polygon(0_0,0_100%,26%_74%,44%_100%,59%_92%,42%_64%,75%_66%)] drop-shadow-[0_2px_1px_var(--color-brand-navy)] ${isAnimating ? "motion-safe:animate-landing-hero-pointer" : ""}`} />
      </div>
    </div>
  </div>;
}
