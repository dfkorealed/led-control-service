import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";

export type SceneKind = "monitoring" | "control" | "statistics" | "report" | "map";
export type SceneMotion = {
  phase: "playing" | "complete";
  run: number;
  replay: () => void;
  stop: () => void;
};

const durations: Record<SceneKind, number> = { monitoring: 3500, control: 2100, statistics: 2650, report: 1950, map: 2350 };

export function Scene({ kind, id, number, time, eyebrow, title, description, benefit, children }: {
  kind: SceneKind; id: string; number: string; time: string; eyebrow: string;
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
  return <section ref={section} className={`scene scene--${kind} ${phase === "playing" ? "is-playing" : "is-complete"}`} id={id} data-demo={kind} aria-labelledby={`${id}-title`}>
    <div className="container scene-layout">
      <div className="scene-copy">
        <p className="scene-number"><span>{number} / 05</span><span>{time}</span></p>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={`${id}-title`}>{title}</h2>
        <p className="scene-description">{description}</p>
        <p className="scene-benefit">{benefit}</p>
      </div>
      <div className="demo-wrap">{children(motion)}</div>
    </div>
  </section>;
}

export function DemoCard({ title, detail, name, disclaimer, motion, children, className = "" }: {
  title: string; detail: string; name: string; disclaimer: string; motion: SceneMotion; children: ReactNode; className?: string;
}) {
  return <Card className={`demo-card ${className}`} aria-label={name}>
    <div className="demo-toolbar">
      <div className="demo-title"><span className="demo-title__dot" /><strong>{title}</strong><small>{detail}</small></div>
      <Button type="button" variant="ghost" className="replay-button" onClick={motion.replay} aria-label={`${title} 예시 다시 보기`}>↺ <span>다시 보기</span></Button>
    </div>
    {children}
    <p className="demo-disclaimer">{disclaimer}</p>
  </Card>;
}
