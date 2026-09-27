import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "../../../components/ui/Button";
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
  useEffect(() => {
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
    "--brightness-pct": `${brightness}%`, "--glow-opacity": String(brightness / 260),
    "--beam-opacity": String(brightness / 210), "--floor-glow": `${brightness}px`
  } as CSSProperties;
  return <DemoCard title="조명 제어" detail="출입구 그룹" name="밝기 조정 인터랙티브 예시"
    disclaimer="이 화면의 조작은 미리보기에서만 반영됩니다. 실제 장비에 명령을 보내지 않습니다." motion={motion} className="control-demo">
    <div className="control-content" style={vars}>
      <div className="control-visual" aria-hidden="true"><div className="control-visual__glow" /><div className="control-visual__lamp"><span /></div><div className="control-visual__beam" /><div className="control-visual__floor" /><span className="control-visual__caption">출입구 그룹 · 조명 4개</span></div>
      <div className="control-panel card">
        <div className="control-panel__heading"><span>밝기 조정</span><strong>{brightness}%</strong></div>
        <label className="sr-only" htmlFor="brightness-range">출입구 그룹 밝기</label>
        <input ref={range} id="brightness-range" type="range" min="0" max="100" step="1" value={brightness} aria-describedby="brightness-hint"
          onInput={event => updateFromRange(Number(event.currentTarget.value))}
          onChange={event => updateFromRange(Number(event.currentTarget.value))} />
        <div className="range-ends"><span>0%</span><span>100%</span></div>
        <p id="brightness-hint" className="control-hint">슬라이더를 움직여 예시 밝기를 바꿔보세요.</p>
        <Button type="button" variant="primary" className="button button--primary" onClick={() => { manual.current = true; motion.stop(); const value = Number(range.current?.value ?? brightness); setBrightness(value); setStatus(`예시 밝기 ${value}%를 적용했습니다.`); }}>밝기 적용 <span aria-hidden="true">→</span></Button>
        <p className="demo-status" role="status" aria-live="polite">{status}</p>
      </div>
    </div>
  </DemoCard>;
}
