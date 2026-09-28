import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Button } from "../../../components/ui/Button";
import { DemoCard, useConceptPresentation, type SceneMotion } from "./Scene";

type Position = { x: number; y: number };
const clamp = (value: number) => Math.max(5, Math.min(95, value));

export function MapDemo({ motion }: { motion: SceneMotion }) {
  const concept = useConceptPresentation();
  const conceptMarker = useRef<HTMLSpanElement>(null);
  const [placed, setPlaced] = useState(false);
  const [position, setPosition] = useState<Position>({ x: 72, y: 53 });
  const [status, setStatus] = useState("조명 배치 버튼으로 위치를 추가해 보세요.");
  const [ghost, setGhost] = useState<Position | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const toolIcon = useRef<HTMLElement>(null);
  const ghostNode = useRef<HTMLSpanElement>(null);
  const marker = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ id: number; startX: number; startY: number; moving: boolean } | null>(null);
  const markerDrag = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const manual = useRef(false);
  const previousRun = useRef(motion.run);

  useEffect(() => {
    // Replay keeps the tool controls mounted; reset the state that remounting
    // previously reset, including reduced-motion complete → complete runs.
    if (previousRun.current !== motion.run) {
      previousRun.current = motion.run;
      manual.current = false;
      drag.current = null;
      markerDrag.current = null;
      suppressClick.current = false;
      setGhost(null);
    }
    if (motion.phase === "complete") {
      if (!manual.current) { setPlaced(true); setPosition({ x: 72, y: 53 }); setStatus("도면에 예시 조명을 배치한 뒤 위치를 조정했습니다."); }
      return;
    }
    setPlaced(false);
    setPosition({ x: 72, y: 53 });
    setStatus("도면에 조명을 배치하고 있습니다.");
    const contentRect = content.current?.getBoundingClientRect();
    const sourceRect = toolIcon.current?.getBoundingClientRect();
    const canvasRect = canvas.current?.getBoundingClientRect();
    const ghost = ghostNode.current;
    let animation: Animation | null = null;
    let markerAnimation: Animation | null = null;
    if (contentRect && sourceRect && canvasRect && ghost && typeof ghost.animate === "function") {
      const startX = sourceRect.left + sourceRect.width / 2 - contentRect.left;
      const startY = sourceRect.top + sourceRect.height / 2 - contentRect.top;
      const dx = canvasRect.left + canvasRect.width * .65 - contentRect.left - startX;
      const dy = canvasRect.top + canvasRect.height * .36 - contentRect.top - startY;
      ghost.style.left = `${startX - 9}px`;
      ghost.style.top = `${startY - 9}px`;
      ghost.classList.add("is-visible", "opacity-100");
      ghost.classList.remove("opacity-0");
      animation = ghost.animate([
        { transform: "translate(0, 0) scale(.8)", opacity: 0 },
        { transform: `translate(${dx * .35}px, ${dy * .15}px) scale(1.12)`, opacity: 1, offset: .35 },
        { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: 1 }
      ], { duration: 1150, easing: "ease-in-out", fill: "forwards" });
    }
    const drop = window.setTimeout(() => {
      animation?.cancel();
      ghost?.classList.remove("is-visible", "opacity-100"); ghost?.classList.add("opacity-0");
      setPlaced(true); setPosition({ x: 65, y: 36 });
      setStatus("예시 조명을 도면에 놓았습니다. 위치를 조정합니다.");
      // The archived concept starts its native marker motion at the drop,
      // including the original scale peak; the site's draggable marker keeps
      // its existing delayed CSS movement and keyboard/pointer contract.
      if (concept) markerAnimation = conceptMarker.current?.animate([
        { left: "65%", top: "36%", transform: "scale(1)" },
        { left: "72%", top: "53%", transform: "scale(1.18)", offset: .72 },
        { left: "72%", top: "53%", transform: "scale(1)" }
      ], { duration: 950, easing: "ease-in-out", fill: "forwards" }) ?? null;
    }, 1150);
    const move = concept ? undefined : window.setTimeout(() => setPosition({ x: 72, y: 53 }), 1400);
    return () => { window.clearTimeout(drop); window.clearTimeout(move); animation?.cancel(); markerAnimation?.cancel(); ghost?.classList.remove("is-visible", "opacity-100"); ghost?.classList.add("opacity-0"); };
  }, [motion.run, motion.phase, concept]);

  function toMapPosition(clientX: number, clientY: number): Position | null {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    return { x: clamp((clientX - rect.left) / rect.width * 100), y: clamp((clientY - rect.top) / rect.height * 100) };
  }
  function onToolMove(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    if (!current.moving && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 8) {
      current.moving = true; manual.current = true; motion.stop();
    }
    if (current.moving && content.current) {
      const rect = content.current.getBoundingClientRect();
      setGhost({ x: event.clientX - rect.left - 9, y: event.clientY - rect.top - 9 });
    }
  }
  function onToolUp(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    if (!current.moving) return;
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    setGhost(null);
    const next = toMapPosition(event.clientX, event.clientY);
    if (!next) { setStatus("도면 안에 조명 도구를 놓아 주세요. 기존 배치는 유지됩니다."); return; }
    setPlaced(true); setPosition(next);
    setStatus("도면에 예시 조명을 직접 끌어 놓았습니다.");
  }
  const markerStyle: CSSProperties = { left: `${position.x}%`, top: `${position.y}%` };
  return <DemoCard title="맵 편집" detail="지하 1층 · 예시" name="도면 위 조명 배치 인터랙티브 예시"
    disclaimer="운영자가 도면과 위치를 직접 편집하는 예시입니다. 자동 등록이나 실제 저장은 수행하지 않습니다." motion={motion}
    className={`map-demo ${placed ? "has-placed" : ""}`}>
    <div className="map-content relative p-landing-map-content-inset landing-narrow:p-landing-demo-content-compact-inset" ref={content}>
      <div className="map-tools flex items-center flex-wrap gap-landing-map-toolbar-gap mb-3.5"><span className="mr-auto text-landing-demo-meta font-extrabold landing-narrow:basis-full">배치 도구</span>
        <Button type="button" variant="landingMapTool" className="button button--tool"
          onPointerDown={event => { if (event.button !== 0) return; drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, moving: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={onToolMove} onPointerUp={onToolUp} onPointerCancel={() => { drag.current = null; setGhost(null); }}
          onClick={() => { if (suppressClick.current) return; if (concept) { motion.replay(); return; } manual.current = true; motion.stop(); setPlaced(true); setStatus("도면에 예시 조명 하나를 직접 배치했습니다."); }}><i className="size-2 border-2 border-surface-panel rounded-landing-ellipse" ref={toolIcon} aria-hidden="true" /> 조명 배치</Button>
        <Button type="button" variant="landingMapCancel" className="button button--quiet" onClick={() => { manual.current = true; motion.stop(); setPlaced(false); if (concept) setPosition({ x: 72, y: 53 }); setStatus("추가한 예시 조명의 배치를 취소했습니다."); }}>배치 취소</Button>
      </div>
      <span ref={ghostNode} className={`map-drag-ghost pointer-events-none absolute z-5 left-0 top-0 size-4.5 border-4 border-brand-blue rounded-landing-ellipse bg-surface-panel shadow-landing-map-drag-preview ${ghost ? "is-visible opacity-100" : "opacity-0"}`} style={ghost ? { left: ghost.x, top: ghost.y } : undefined} aria-hidden="true" />
      <div className="map-canvas relative h-[clamp(250px,27vw,340px)] overflow-hidden border border-border-default rounded-control bg-surface-panel landing-narrow:h-[245px]" ref={canvas} aria-label="조명 위치를 배치해 보는 예시 도면">
        <div className="map-canvas__grid absolute inset-0 opacity-65 bg-landing-preview-editor-grid bg-size-[25px_25px]" aria-hidden="true" /><div className="map-canvas__room map-canvas__room--a absolute grid place-items-center border-2 border-border-default bg-brand-paper text-status-neutral-foreground text-landing-demo-meta font-[750] left-9/100 top-12/100 w-[51%] h-[67%]">주차 구역 A</div><div className="map-canvas__room map-canvas__room--b absolute grid place-items-center border-2 border-border-default bg-action-primary-soft text-brand-blue text-landing-demo-meta font-[750] left-59/100 top-27/100 w-[28%] h-[52%]">출입구</div><div className="map-canvas__wall absolute left-9/100 right-13/100 top-82/100 border-t-3 border-brand-blue" aria-hidden="true" />
        <span className="map-light map-light--one absolute z-2 size-4.5 border-4 border-brand-blue rounded-landing-ellipse bg-surface-panel ring-5 ring-action-primary-soft left-24/100 top-34/100" aria-hidden="true" /><span className="map-light map-light--two absolute z-2 size-4.5 border-4 border-brand-blue rounded-landing-ellipse bg-surface-panel ring-5 ring-action-primary-soft left-39/100 top-56/100" aria-hidden="true" />
        {concept && <span ref={conceptMarker} aria-hidden="true" className={`map-light map-light--placed absolute z-2 size-4.5 border-4 border-brand-blue rounded-landing-ellipse bg-surface-panel ring-5 ring-action-primary-soft ${placed ? "opacity-100" : "opacity-0"}`} style={markerStyle} />}
        {!concept && placed && <Button variant="landingMapMarker" ref={marker} className={`map-light map-light--placed ${motion.phase === "playing" && !manual.current ? "is-auto-moving transition-[left,top] duration-[950ms] ease-[ease-in-out]" : ""}`} style={markerStyle} type="button" aria-label="배치한 조명 이동"
          onPointerDown={event => { if (event.button !== 0) return; markerDrag.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); manual.current = true; motion.stop(); }}
          onPointerMove={event => { if (markerDrag.current !== event.pointerId) return; const next = toMapPosition(event.clientX, event.clientY); if (next) setPosition(next); }}
          onPointerUp={() => { markerDrag.current = null; setStatus("예시 조명의 위치를 조정했습니다."); }}
          onPointerCancel={() => { markerDrag.current = null; }}
          onKeyDown={event => { const direction = { ArrowLeft: [-3,0], ArrowRight: [3,0], ArrowUp: [0,-3], ArrowDown: [0,3] }[event.key] as [number,number] | undefined; if (!direction) return; event.preventDefault(); manual.current = true; motion.stop(); setPosition(current => ({ x: clamp(current.x + direction[0]), y: clamp(current.y + direction[1]) })); setStatus("예시 조명의 위치를 조정했습니다."); }} >{null}</Button>}
        <span className="map-canvas__hint absolute left-landing-map-hint-left bottom-2.5 p-landing-demo-status-label-inset rounded-landing-map-hint bg-surface-panel text-content-secondary text-landing-demo-caption">조명 위치를 직접 배치하는 예시</span>
      </div>
      <div className="map-bottom flex justify-between gap-2.5 mt-3.5 text-content-secondary text-landing-demo-meta font-[750]"><span>배치된 조명 {placed ? 3 : 2}개</span><span className="map-save text-content-primary">배치 검토 → 저장</span></div>
      <p className="demo-status mb-0 mx-0 mt-landing-map-result-top-space text-brand-blue text-landing-demo-status font-[750]" role="status" aria-live="polite">{status}</p>
    </div>
  </DemoCard>;
}
