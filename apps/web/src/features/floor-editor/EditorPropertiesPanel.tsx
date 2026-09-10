import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui";
import { placementLabel } from "./FixturePlacementList";
import { useFloorEditorStore } from "./editor-store";
import type { FloorMapObject } from "./editor-types";

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
  if (!state || !selected?.value) return <MapProperties readOnly={readOnly} />;

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
          <input type="number" disabled={readOnly} value={fixture.ratedWatt} onChange={(event) => updateFixture(fixture.id, { ratedWatt: Number(event.target.value) })} />
        </label>
        <div className="editor-property-grid">
          <NumberProperty label="X" value={fixture.x} disabled={readOnly || fixture.placementStatus === "unplaced"} onChange={(x) => updateFixture(fixture.id, { x })} />
          <NumberProperty label="Y" value={fixture.y} disabled={readOnly || fixture.placementStatus === "unplaced"} onChange={(y) => updateFixture(fixture.id, { y })} />
          <NumberProperty label="크기" value={fixture.size ?? 20} disabled={readOnly} onChange={(size) => updateFixture(fixture.id, { size })} />
        </div>
      </aside>
    );
  }

  const object = selected.value;
  return <ObjectProperties object={object} readOnly={readOnly || object.locked || layers.objects.locked} onChange={(patch) => updateObject(object.id, patch)} />;
}

function MapProperties({ readOnly }: { readOnly: boolean }) {
  const floorPlan = useFloorEditorStore((s) => s.state?.floor.floorPlan);
  const updateMapSettings = useFloorEditorStore((s) => s.updateMapSettings);
  const [width, setWidth] = useState(floorPlan?.width ?? 1200);
  const [height, setHeight] = useState(floorPlan?.height ?? 800);
  const [gridSize, setGridSize] = useState(floorPlan?.gridSize ?? 10);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWidth(floorPlan?.width ?? 1200);
    setHeight(floorPlan?.height ?? 800);
    setGridSize(floorPlan?.gridSize ?? 10);
    setError(null);
  }, [floorPlan?.width, floorPlan?.height, floorPlan?.gridSize]);

  return (
    <aside className="editor-properties-panel" aria-label="속성 패널">
      <span className="eyebrow">맵 전체</span>
      <h3>맵 설정</h3>
      <p className="muted-text">아무 요소도 선택하지 않았습니다.</p>
      <div className="editor-property-grid">
        <NumberProperty label="맵 너비" value={width} disabled={readOnly} min={1} onChange={setWidth} />
        <NumberProperty label="맵 높이" value={height} disabled={readOnly} min={1} onChange={setHeight} />
      </div>
      <NumberProperty label="격자 간격" value={gridSize} disabled={readOnly} min={5} max={200} onChange={setGridSize} />
      <p className="muted-text">격자 간격은 5~200 사이에서 설정할 수 있습니다.</p>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <Button
        variant="primary"
        disabled={readOnly || width === (floorPlan?.width ?? 1200) && height === (floorPlan?.height ?? 800) && gridSize === (floorPlan?.gridSize ?? 10)}
        onClick={() => setError(updateMapSettings({ width, height, gridSize }))}
      >
        맵 설정 적용
      </Button>
    </aside>
  );
}

function ObjectProperties({ object, readOnly, onChange }: {
  object: FloorMapObject;
  readOnly: boolean;
  onChange: (patch: Partial<FloorMapObject>) => void;
}) {
  const names = { rectangle: "네모", triangle: "세모", line: "선", text: "텍스트" } as const;
  const number = (key: "x" | "y" | "width" | "height", label: string) => (
    <NumberProperty key={key} label={label} value={object[key]} disabled={readOnly} onChange={(value) => onChange({ [key]: value })} />
  );

  return (
    <aside className="editor-properties-panel" aria-label="속성 패널">
      <span className="eyebrow">{names[object.type]} 속성</span>
      <h3>{names[object.type]}</h3>
      <div className="editor-property-grid">
        {number("x", "X")}
        {number("y", "Y")}
        {object.type === "line" ? number("width", "길이") : (
          <>
            {number("width", "너비")}
            {number("height", "높이")}
          </>
        )}
      </div>
      {object.type === "text" ? (
        <>
          <label>
            텍스트 내용
            <input disabled={readOnly} value={object.text} onChange={(event) => onChange({ text: event.target.value })} />
          </label>
          <NumberProperty label="글자 크기" value={object.fontSize ?? 16} disabled={readOnly} min={1} onChange={(fontSize) => onChange({ fontSize })} />
          <ColorProperty label="글자 색상" value={object.strokeColor} disabled={readOnly} onChange={(strokeColor) => onChange({ strokeColor })} />
        </>
      ) : (
        <>
          <ColorProperty label="선 색상" value={object.strokeColor} disabled={readOnly} onChange={(strokeColor) => onChange({ strokeColor })} />
          {object.type !== "line" ? <ColorProperty label="채우기 색상" value={object.fillColor ?? ""} disabled={readOnly} onChange={(fillColor) => onChange({ fillColor })} /> : null}
          <NumberProperty label="선 두께" value={object.strokeWidth} disabled={readOnly} min={1} onChange={(strokeWidth) => onChange({ strokeWidth })} />
        </>
      )}
    </aside>
  );
}

function NumberProperty({ label, value, disabled, min = 0, max, onChange }: {
  label: string;
  value: number;
  disabled: boolean;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        aria-label={label}
        disabled={disabled}
        min={min}
        max={max}
        value={Math.round(value)}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next) && next >= min && (max === undefined || next <= max)) onChange(next);
        }}
      />
    </label>
  );
}

function ColorProperty({ label, value, disabled, onChange }: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <input type="color" aria-label={label} disabled={disabled} value={normalizeColorValue(value)} onChange={(event) => onChange(event.target.value)} />
    </label>
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
  return <aside className="editor-properties-panel" aria-label="속성 패널"><span className="eyebrow">조명 일괄 속성</span><h3>{ids.length}개 선택</h3><p>수정 대상 {fixtures.length}개</p>
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
