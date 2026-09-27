import { useEffect, useRef, useState } from "react";
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
  useEffect(() => {
    if (motion.phase === "complete") {
      if (!manual.current) setSelected("02");
      return;
    }
    manual.current = false;
    setSelected(null);
    const first = window.setTimeout(() => setSelected("01"), 1100);
    const second = window.setTimeout(() => setSelected("02"), 2350);
    return () => { window.clearTimeout(first); window.clearTimeout(second); };
    // A new run remounts the scene timeline; manual selection stops its timers.
  }, [motion.run, motion.phase]);
  const active = fixtures.find(fixture => fixture.id === selected);
  return <DemoCard title="현장 모니터링" detail="본관 · 지하 1층" name="조명 선택 인터랙티브 예시"
    disclaimer="설명을 위한 예시 도면과 상태입니다. 실제 현장 데이터가 아닙니다." motion={motion} className="monitoring-demo">
    <div className="monitoring-content">
      <div className="floorplan" aria-label="예시 주차장 도면에서 조명을 선택할 수 있습니다">
        <div className="floorplan__top"><span>B1 · 주차장</span><span>출입구 구역</span></div>
        <div className="floorplan__drawing">
          <div className="parking-spaces parking-spaces--top" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</div>
          <div className="parking-spaces parking-spaces--bottom" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</div>
          <div className="floorplan__lane" aria-hidden="true" />
          <span className="floorplan__entry">출입구</span>
          {fixtures.map((fixture, index) => <button key={fixture.id} className={`fixture fixture--${"abcd"[index]}`} type="button"
            aria-label={`${fixture.name} 선택`} aria-pressed={selected === fixture.id}
            onClick={() => { manual.current = true; motion.stop(); setSelected(fixture.id); }}><span /></button>)}
          <div className="demo-cursor" aria-hidden="true" />
        </div>
        <div className="floorplan__legend"><span><i />조명 위치</span><span><i />선택한 조명</span></div>
      </div>
      <div className="inspector card">
        <span className="inspector__label">선택한 조명</span><strong>{active?.name ?? "조명을 선택하세요"}</strong>
        {active && <><span className="status-pill"><i />연결됨</span><dl><div><dt>최근 확인 상태</dt><dd>켜짐</dd></div><div><dt>위치</dt><dd>{active.location}</dd></div></dl></>}
        <p className="demo-status" role="status" aria-live="polite">{active ? `선택한 조명: ${active.name}` : "도면에서 조명을 선택해 보세요."}</p>
      </div>
    </div>
  </DemoCard>;
}
