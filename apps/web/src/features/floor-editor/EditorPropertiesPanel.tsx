import { useMemo, useState } from "react";
import { Button } from "../../components/ui";
import { placementLabel } from "./FixturePlacementList";
import { useFloorEditorStore } from "./editor-store";

export function EditorPropertiesPanel({ readOnly = false }: { readOnly?: boolean }) {
  const { state, selection, updateFixture, updateObject } = useFloorEditorStore();
  const ids = useFloorEditorStore((s) => s.selectedFixtureIds);
  const layers = useFloorEditorStore((s) => s.layers);
  const lockedIds = useFloorEditorStore((s) => s.lockedFixtureIds);
  const selected = useMemo(() => {
    if (!state || !selection) return null;
    if (selection.kind === "fixture") {
      return { kind: "fixture" as const, value: state.fixtures.find((fixture) => fixture.id === selection.id) ?? null };
    }
    return { kind: "object" as const, value: state.objects.find((object) => object.id === selection.id) ?? null };
  }, [state, selection]);

  if (ids.length > 1) return <BatchProperties readOnly={readOnly || layers.fixtures.locked} />;
  if (!state || !selected?.value) {
    return (
      <aside className="editor-properties-panel" aria-label="속성 패널">
        <span className="eyebrow">속성</span>
        <h3>선택 없음</h3>
      </aside>
    );
  }

  if (selected.kind === "fixture") {
    const fixture = selected.value;
    readOnly ||= layers.fixtures.locked || lockedIds.includes(fixture.id);
    return (
      <aside className="editor-properties-panel" aria-label="속성 패널">
        <span className="eyebrow">조명 속성</span>
        <h3>{fixture.name}</h3>
        <p>{placementLabel(fixture)}</p>
        <label>
          조명명
          <input disabled={readOnly} value={fixture.name} onChange={(event) => updateFixture(fixture.id, { name: event.target.value })} />
        </label>
        <label>
          정격 전력
          <input
            type="number"
            disabled={readOnly}
            value={fixture.ratedWatt}
            onChange={(event) => updateFixture(fixture.id, { ratedWatt: Number(event.target.value) })}
          />
        </label>
        <div className="editor-property-grid">
          <label>
            X
            <input type="number" disabled={readOnly || fixture.placementStatus === "unplaced"} value={Math.round(fixture.x)} onChange={(event) => updateFixture(fixture.id, { x: Number(event.target.value) })} />
          </label>
          <label>
            Y
            <input type="number" disabled={readOnly || fixture.placementStatus === "unplaced"} value={Math.round(fixture.y)} onChange={(event) => updateFixture(fixture.id, { y: Number(event.target.value) })} />
          </label>
          <label>
            크기
            <input type="number" disabled={readOnly} value={Math.round(fixture.size ?? 20)} onChange={(event) => updateFixture(fixture.id, { size: Number(event.target.value) })} />
          </label>
        </div>
      </aside>
    );
  }

  const object = selected.value;
  readOnly ||= object.locked || layers.objects.locked;
  return (
    <aside className="editor-properties-panel" aria-label="속성 패널">
      <span className="eyebrow">도형 속성</span>
      <h3>{object.type}</h3>
      <div className="editor-property-grid">{(["x", "y", "width", "height"] as const).map((key) => <label key={key}>{({ x: "X", y: "Y", width: "너비", height: "높이" })[key]}<input type="number" disabled={readOnly || object.type === "line" && key === "height"} value={object[key]} onChange={(e) => {
        const value = Number(e.target.value); if (!Number.isFinite(value) || value < 0) return;
        const width = key === "width" ? value : object.width, height = key === "height" ? value : object.height;
        updateObject(object.id, { [key]: value, ...(object.type === "triangle" ? { points: [{ x: width / 2, y: 0 }, { x: width, y: height }, { x: 0, y: height }] } : {}) });
      }} /></label>)}</div>
      <label>
        선 색상
        <input type="color" disabled={readOnly} value={normalizeColorValue(object.strokeColor)} onChange={(event) => updateObject(object.id, { strokeColor: event.target.value })} />
      </label>
      <label>
        채우기 색상
        <input type="color" disabled={readOnly} value={normalizeColorValue(object.fillColor ?? "")} onChange={(event) => updateObject(object.id, { fillColor: event.target.value })} />
      </label>
      <label>
        선 두께
        <input type="number" disabled={readOnly} value={object.strokeWidth} onChange={(event) => updateObject(object.id, { strokeWidth: Number(event.target.value) })} />
      </label>
      <label>
        텍스트
        <input disabled={readOnly} value={object.text} onChange={(event) => updateObject(object.id, { text: event.target.value })} />
      </label>
      <label>
        글자 크기
        <input type="number" disabled={readOnly} value={object.fontSize ?? 16} onChange={(event) => updateObject(object.id, { fontSize: Number(event.target.value) })} />
      </label>
    </aside>
  );
}

function BatchProperties({ readOnly }: { readOnly: boolean }) {
  const state = useFloorEditorStore((s) => s.state);
  const ids = useFloorEditorStore((s) => s.selectedFixtureIds);
  const locked = useFloorEditorStore((s) => s.lockedFixtureIds);
  const [prefix, setPrefix] = useState("");
  const [start, setStart] = useState(1);
  const [size, setSize] = useState("");
  const [watt, setWatt] = useState("");
  const [preview, setPreview] = useState(false);
  const fixtures = state?.fixtures.filter((f) => ids.includes(f.id) && !locked.includes(f.id)) ?? [];
  const mixed = (key: "size" | "ratedWatt") => new Set(fixtures.map((f) => f[key] ?? 20)).size > 1 ? "혼합값" : String(fixtures[0]?.[key] ?? "");
  const valid = (!size || Number.isFinite(Number(size)) && Number(size) >= 4 && Number(size) <= 200) && (!watt || Number.isFinite(Number(watt)) && Number(watt) >= 0 && Number(watt) <= 10000) && Number.isInteger(start) && start >= 0;
  return <aside className="editor-properties-panel" aria-label="속성 패널"><h3>{ids.length}개 선택</h3><p>수정 대상 {fixtures.length}개</p>
    <label>이름 접두어<input value={prefix} maxLength={100} onChange={(e) => { setPrefix(e.target.value); setPreview(false); }} /></label>
    <label>시작 번호<input type="number" value={start} min={0} onChange={(e) => { setStart(Number(e.target.value)); setPreview(false); }} /></label>
    <label>일괄 크기<input type="number" value={size} placeholder={mixed("size")} onChange={(e) => { setSize(e.target.value); setPreview(false); }} /></label>
    <label>일괄 정격 전력<input type="number" value={watt} placeholder={mixed("ratedWatt")} onChange={(e) => { setWatt(e.target.value); setPreview(false); }} /></label>
    <Button disabled={readOnly || !fixtures.length || !valid || !prefix && !size && !watt} onClick={() => setPreview(true)}>속성 미리보기</Button>
    {preview && <><ul className="editor-name-preview">{fixtures.slice(0, 3).map((f, i) => <li key={f.id}>{f.name} → {prefix ? `${prefix}${String(start + i).padStart(2, "0")}` : f.name}{size && ` · 크기 ${size}`}{watt && ` · ${watt} W`}</li>)}</ul><p>{fixtures.length}개 적용 예정</p>
      <Button variant="primary" disabled={readOnly || !valid} onClick={() => { useFloorEditorStore.getState().updateFixtureProperties(fixtures.map((f) => f.id), (_f, i) => ({ ...(prefix ? { name: `${prefix}${String(start + i).padStart(2, "0")}` } : {}), ...(size ? { size: Number(size) } : {}), ...(watt ? { ratedWatt: Number(watt) } : {}) })); setPreview(false); }}>속성 적용</Button></>}
    <Button variant="secondary" disabled={readOnly} onClick={() => useFloorEditorStore.getState().toggleFixtureLock(ids)}>선택 잠금 전환</Button>
  </aside>;
}

function normalizeColorValue(color: string) {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#2563eb";
}
