import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";

const ConceptPresentation = createContext(false);
export function useConceptPresentation() { return useContext(ConceptPresentation); }

export type SceneKind = "monitoring" | "control" | "statistics" | "report" | "map";
export type SceneMotion = {
  phase: "playing" | "complete";
  run: number;
  replay: () => void;
  stop: () => void;
};

const durations: Record<SceneKind, number> = { monitoring: 3500, control: 2100, statistics: 2650, report: 1950, map: 2350 };

export function Scene({ visualVariant = "site", kind, id, number, time, eyebrow, title, description, benefit, children }: {
  visualVariant?: "site" | "concept"; kind: SceneKind; id: string; number: string; time: string; eyebrow: string;
  title: ReactNode; description: string; benefit: string; children: (motion: SceneMotion) => ReactNode;
}) {
  const section = useRef<HTMLElement>(null);
  const timer = useRef<number | null>(null);
  const visible = useRef(false);
  const [run, setRun] = useState(0);
  const [phase, setPhase] = useState<"playing" | "complete">("complete");
  const stop = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setPhase("complete");
  }, []);
  const replay = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setRun(current => current + 1);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setPhase("complete");
      return;
    }
    setPhase("playing");
    timer.current = window.setTimeout(() => { timer.current = null; setPhase("complete"); }, durations[kind]);
  }, [kind]);

  useEffect(() => {
    const node = section.current;
    if (!node) return;
    if (!('IntersectionObserver' in window)) { replay(); return; }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.target !== node) continue;
        if (entry.intersectionRatio >= .15 && !visible.current) { visible.current = true; replay(); }
        else if (entry.intersectionRatio <= .001 && visible.current) { visible.current = false; stop(); }
      }
    }, { threshold: [0, .15] });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [replay, stop]);

  const motion: SceneMotion = { phase, run, replay, stop };
  const dark = kind === "statistics";
  const surface = { monitoring: "bg-brand-paper", control: "bg-action-primary-soft", statistics: "bg-brand-navy text-surface-panel", report: "bg-surface-panel", map: "bg-brand-paper" }[kind];
  return <section ref={section} className={`scene scene--${kind} ${visualVariant === "concept" ? "" : "scroll-mt-landing-anchor-anchor-offset"} relative flex min-h-svh overflow-hidden ${surface} ${phase === "playing" ? "is-playing" : "is-complete"}`} id={id} data-demo={kind} aria-labelledby={`${id}-title`}>
    <span aria-hidden="true" className={`scene-watermark pointer-events-none absolute top-10/100 -right-1/100 opacity-[.035] text-landing-scene-watermark font-[850] uppercase landing-stack:top-3/100 ${kind === "monitoring" ? "tracking-landing-monitoring-watermark" : ""}`}>{kind}</span>
    <div className={`scene-layout mx-auto grid w-[min(1180px,calc(100%-72px))] grid-cols-[minmax(300px,.84fr)_minmax(0,1.16fr)] items-center gap-landing-scene-frame-gap py-landing-scene-frame-block-inset ${visualVariant === "site" ? "phone-wide:max-w-[360px] compact:max-w-[760px] tablet:max-w-[1024px]" : ""} landing-wide:grid-cols-1 landing-wide:gap-landing-scene-frame-medium-gap landing-wide:landing-stack:w-[calc(100%-38px)] landing-wide:landing-stack:py-landing-scene-frame-stacked-block-inset landing-wide:landing-stack:landing-narrow:w-[calc(100%-30px)] landing-wide:landing-stack:landing-narrow:gap-landing-scene-frame-narrow-gap landing-wide:landing-stack:landing-narrow:py-landing-scene-frame-narrow-block-inset`}>
      <div className="scene-copy relative z-1 landing-wide:max-w-[760px]">
        <p className={`scene-number flex flex-wrap justify-between gap-4 max-w-[405px] m-landing-scene-number-margin pb-4 border-b text-landing-scene-number font-[850] landing-wide:mb-10 landing-wide:landing-stack:landing-narrow:mb-landing-scene-number-narrow-bottom-space ${dark ? "border-surface-panel/25 text-action-primary-soft" : "border-border-subtle text-status-neutral-foreground"}`}><span>{visualVariant === "concept" ? `${number} / 05` : <>{number} / 05</>}</span><span>{time}</span></p>
        <p className={`m-0 text-landing-eyebrow font-[850] uppercase ${dark ? "text-action-primary-soft" : "text-brand-blue"}`}>{eyebrow}</p>
        <h2 id={`${id}-title`} className={`${visualVariant === "concept" ? "" : "scroll-mt-landing-anchor-anchor-offset"} m-landing-scene-heading-margin text-landing-scene-heading font-[850] landing-stack:text-landing-scene-heading-stacked landing-stack:landing-narrow:text-landing-scene-heading-narrow`}>{title}</h2>
        <p className={`scene-description max-w-[430px] m-0 text-landing-scene-description landing-narrow:text-landing-narrative-copy-narrow ${dark ? "text-action-primary-soft" : visualVariant === "concept" ? "text-content-secondary" : "text-status-neutral-foreground"}`}>{description}</p>
        <p className={`scene-benefit flex items-start gap-2.5 max-w-[450px] m-landing-scene-benefit-margin pt-landing-scene-benefit-top-inset border-t text-landing-scene-benefit font-extrabold landing-narrow:mt-landing-scene-benefit-narrow-top-space landing-narrow:pt-landing-scene-benefit-narrow-top-inset landing-narrow:text-landing-scene-benefit-narrow ${dark ? "border-surface-panel/25 text-surface-panel" : "border-border-subtle text-brand-navy"}`}><span aria-hidden="true" className="scene-benefit__marker text-brand-coral text-landing-scene-benefit-marker">↳</span>{benefit}</p>
      </div>
      <div className="demo-wrap relative z-1 min-w-0 landing-wide:w-[min(100%,760px)] landing-wide:mx-auto">
        <div aria-hidden="true" className={`demo-backplate absolute -z-1 right-landing-demo-backplate-right bottom-landing-demo-backplate-bottom w-[70%] h-[65%] rounded-landing-demo-backplate landing-stack:-right-3 landing-stack:bottom-landing-demo-backplate-stacked-bottom ${dark ? "bg-action-primary-soft/15" : kind === "control" || kind === "map" ? "bg-border-default" : "bg-action-primary-soft"}`} />
        <ConceptPresentation.Provider value={visualVariant === "concept"}>{children(motion)}</ConceptPresentation.Provider>
      </div>
    </div>
  </section>;
}

export function DemoCard({ title, detail, name, disclaimer, motion, children, className = "" }: {
  title: string; detail: string; name: string; disclaimer: string; motion: SceneMotion; children: ReactNode; className?: string;
}) {
  const concept = useContext(ConceptPresentation);
  return <Card variant="landingDemo" className={`demo-card ${className}`} aria-label={name}>
    <div className="demo-toolbar flex items-center justify-between gap-3 min-h-[60px] px-landing-demo-frame-inline-inset border-b border-border-subtle landing-narrow:min-h-[53px] landing-narrow:px-landing-demo-frame-compact-inline-inset">
      <div className="demo-title flex items-center gap-2.5 min-w-0 text-landing-demo-title landing-narrow:gap-landing-demo-title-narrow-gap"><span className="demo-title__dot flex-none size-2 rounded-landing-ellipse bg-brand-coral" /><strong className="whitespace-nowrap">{title}</strong><small className="overflow-hidden pl-2.5 border-l border-border-subtle text-content-secondary text-landing-demo-meta text-ellipsis whitespace-nowrap landing-narrow:hidden">{detail}</small></div>
      <Button type="button" variant={concept ? "landingConceptReplay" : "landingReplay"} className="replay-button" onClick={motion.replay} aria-label={`${title} 예시 다시 보기`}>↺ <span className="landing-narrow:hidden">다시 보기</span></Button>
    </div>
    {children}
    <p className="demo-disclaimer m-0 p-landing-demo-disclaimer-inset border-t border-border-subtle bg-surface-inset text-content-secondary text-landing-demo-disclaimer landing-narrow:px-landing-demo-frame-compact-inline-inset">{disclaimer}</p>
  </Card>;
}
