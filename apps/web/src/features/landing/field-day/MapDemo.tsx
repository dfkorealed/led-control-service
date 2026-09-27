import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Button } from "../../../components/ui/Button";
import { DemoCard, type SceneMotion } from "./Scene";

type Position = { x: number; y: number };
const clamp = (value: number) => Math.max(5, Math.min(95, value));

export function MapDemo({ motion }: { motion: SceneMotion }) {
  const [placed, setPlaced] = useState(false);
  const [position, setPosition] = useState<Position>({ x: 72, y: 53 });
  const [status, setStatus] = useState("조명 배치 버튼으로 위치를 추가해 보세요.");
  const [ghost, setGhost] = useState<Position | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const tool = useRef<HTMLButtonElement>(null);
  const marker = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ id: number; startX: number; startY: number; moving: boolean } | null>(null);
  const markerDrag = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const manual = useRef(false);

  useEffect(() => {
    if (motion.phase === "complete") {
      if (!manual.current) { setPlaced(true); setPosition({ x: 72, y: 53 }); setStatus("도면에 예시 조명을 배치한 뒤 위치를 조정했습니다."); }
      return;
    }
    manual.current = false;
    setPlaced(false);
    setPosition({ x: 72, y: 53 });
    setStatus("도면에 조명을 배치하고 있습니다.");
    const contentRect = content.current?.getBoundingClientRect();
    const sourceRect = tool.current?.querySelector("i")?.getBoundingClientRect();
    const canvasRect = canvas.current?.getBoundingClientRect();
    const ghostNode = content.current?.querySelector<HTMLElement>(".map-drag-ghost");
    let animation: Animation | null = null;
    if (contentRect && sourceRect && canvasRect && ghostNode && typeof ghostNode.animate === "function") {
      const startX = sourceRect.left + sourceRect.width / 2 - contentRect.left;
      const startY = sourceRect.top + sourceRect.height / 2 - contentRect.top;
      const dx = canvasRect.left + canvasRect.width * .65 - contentRect.left - startX;
      const dy = canvasRect.top + canvasRect.height * .36 - contentRect.top - startY;
      ghostNode.style.left = `${startX - 9}px`;
      ghostNode.style.top = `${startY - 9}px`;
      ghostNode.classList.add("is-visible");
      animation = ghostNode.animate([
        { transform: "translate(0, 0) scale(.8)", opacity: 0 },
        { transform: `translate(${dx * .35}px, ${dy * .15}px) scale(1.12)`, opacity: 1, offset: .35 },
        { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: 1 }
      ], { duration: 1150, easing: "ease-in-out", fill: "forwards" });
    }
    const drop = window.setTimeout(() => {
      animation?.cancel();
      ghostNode?.classList.remove("is-visible");
      setPlaced(true); setPosition({ x: 65, y: 36 });
      setStatus("예시 조명을 도면에 놓았습니다. 위치를 조정합니다.");
    }, 1150);
    const move = window.setTimeout(() => setPosition({ x: 72, y: 53 }), 1400);
    return () => { window.clearTimeout(drop); window.clearTimeout(move); animation?.cancel(); ghostNode?.classList.remove("is-visible"); };
  }, [motion.run, motion.phase]);

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
  const markerStyle = { "--placed-x": `${position.x}%`, "--placed-y": `${position.y}%` } as CSSProperties;
  return <DemoCard title="맵 편집" detail="지하 1층 · 예시" name="도면 위 조명 배치 인터랙티브 예시"
    disclaimer="운영자가 도면과 위치를 직접 편집하는 예시입니다. 자동 등록이나 실제 저장은 수행하지 않습니다." motion={motion}
    className={`map-demo ${placed ? "has-placed" : ""}`}>
    <div className="map-content" ref={content}>
      <div className="map-tools"><span>배치 도구</span>
        <Button ref={tool} type="button" variant="primary" className="button button--tool"
          onPointerDown={event => { if (event.button !== 0) return; drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, moving: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={onToolMove} onPointerUp={onToolUp} onPointerCancel={() => { drag.current = null; setGhost(null); }}
          onClick={() => { if (suppressClick.current) return; manual.current = true; motion.stop(); setPlaced(true); setStatus("도면에 예시 조명 하나를 직접 배치했습니다."); }}><i aria-hidden="true" /> 조명 배치</Button>
        <Button type="button" variant="ghost" className="button button--quiet" onClick={() => { manual.current = true; motion.stop(); setPlaced(false); setStatus("추가한 예시 조명의 배치를 취소했습니다."); }}>배치 취소</Button>
      </div>
      <span className={`map-drag-ghost ${ghost ? "is-visible" : ""}`} style={ghost ? { left: ghost.x, top: ghost.y } : undefined} aria-hidden="true" />
      <div className="map-canvas" ref={canvas} aria-label="조명 위치를 배치해 보는 예시 도면">
        <div className="map-canvas__grid" aria-hidden="true" /><div className="map-canvas__room map-canvas__room--a">주차 구역 A</div><div className="map-canvas__room map-canvas__room--b">출입구</div><div className="map-canvas__wall" aria-hidden="true" />
        <span className="map-light map-light--one" aria-hidden="true" /><span className="map-light map-light--two" aria-hidden="true" />
        {placed && <button ref={marker} className={`map-light map-light--placed ${motion.phase === "playing" && !manual.current ? "is-auto-moving" : ""}`} style={markerStyle} type="button" aria-label="배치한 조명 이동"
          onPointerDown={event => { if (event.button !== 0) return; markerDrag.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); manual.current = true; motion.stop(); }}
          onPointerMove={event => { if (markerDrag.current !== event.pointerId) return; const next = toMapPosition(event.clientX, event.clientY); if (next) setPosition(next); }}
          onPointerUp={() => { markerDrag.current = null; setStatus("예시 조명의 위치를 조정했습니다."); }}
          onPointerCancel={() => { markerDrag.current = null; }}
          onKeyDown={event => { const direction = { ArrowLeft: [-3,0], ArrowRight: [3,0], ArrowUp: [0,-3], ArrowDown: [0,3] }[event.key] as [number,number] | undefined; if (!direction) return; event.preventDefault(); manual.current = true; motion.stop(); setPosition(current => ({ x: clamp(current.x + direction[0]), y: clamp(current.y + direction[1]) })); setStatus("예시 조명의 위치를 조정했습니다."); }} />}
        <span className="map-canvas__hint">조명 위치를 직접 배치하는 예시</span>
      </div>
      <div className="map-bottom"><span>배치된 조명 {placed ? 3 : 2}개</span><span className="map-save">배치 검토 → 저장</span></div>
      <p className="demo-status" role="status" aria-live="polite">{status}</p>
    </div>
  </DemoCard>;
}
