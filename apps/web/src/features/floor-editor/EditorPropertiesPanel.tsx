import { useEffect, useMemo, useState } from "react";
import { Button, FormField, Heading, NumberField, Text, TextField, themeColor } from "../../components/ui";
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
      <aside className="grid content-start gap-3 p-3" aria-label="속성 패널">
        <Text variant="overline" tone="secondary">조명 속성</Text>
        <Heading as="h3" variant="card-title">{fixture.name}</Heading>
        <Text variant="body-sm" tone="secondary">{placementLabel(fixture)}</Text>
        <TextField label="조명명" isDisabled={readOnly} value={fixture.name} onChange={(name) => updateFixture(fixture.id, { name })} />
        <NumberField label="정격 전력" isDisabled={readOnly} minValue={0} value={fixture.ratedWatt} onChange={(ratedWatt) => {
          if (ratedWatt !== null) updateFixture(fixture.id, { ratedWatt });
        }} />
        <div className="grid grid-cols-2 gap-2">
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
  const document = useFloorEditorStore((s) => s.pendingMapStage?.preview ?? s.state?.floor.mapDocument);
  const updateMapSettings = useFloorEditorStore((s) => s.updateMapSettings);
  const [width, setWidth] = useState(floorPlan?.width ?? document?.width ?? 1200);
  const [height, setHeight] = useState(floorPlan?.height ?? document?.height ?? 800);
  const [gridSize, setGridSize] = useState(floorPlan?.gridSize ?? document?.gridSize ?? 10);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWidth(floorPlan?.width ?? document?.width ?? 1200);
    setHeight(floorPlan?.height ?? document?.height ?? 800);
    setGridSize(floorPlan?.gridSize ?? document?.gridSize ?? 10);
    setError(null);
  }, [floorPlan?.width, floorPlan?.height, floorPlan?.gridSize, document]);

  return (
    <aside className="grid content-start gap-3 p-3" aria-label="속성 패널">
      <Text variant="overline" tone="secondary">맵 전체</Text>
      <Heading as="h3" variant="card-title">맵 설정</Heading>
      <Text variant="body-sm" tone="secondary">아무 요소도 선택하지 않았습니다.</Text>
      <div className="grid grid-cols-2 gap-2">
        <NumberProperty label="맵 너비" value={width} disabled={readOnly} min={1} onChange={setWidth} />
        <NumberProperty label="맵 높이" value={height} disabled={readOnly} min={1} onChange={setHeight} />
      </div>
      <NumberProperty label="격자 간격" value={gridSize} disabled={readOnly} min={5} max={200} onChange={setGridSize} />
      <Text variant="caption" tone="secondary">격자 간격은 5~200 사이에서 설정할 수 있습니다.</Text>
      {error ? <Text role="alert" variant="caption" tone="danger">{error}</Text> : null}
      <Button
        variant="primary"
        disabled={readOnly}
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
    <aside className="grid content-start gap-3 p-3" aria-label="속성 패널">
      <Text variant="overline" tone="secondary">{names[object.type]} 속성</Text>
      <Heading as="h3" variant="card-title">{names[object.type]}</Heading>
      <div className="grid grid-cols-2 gap-2">
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
          <TextField label="텍스트 내용" isDisabled={readOnly} value={object.text} onChange={(text) => onChange({ text })} />
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
  return <NumberField label={label} isDisabled={disabled} minValue={min} maxValue={max} value={Math.round(value)} onChange={(next) => {
    if (next !== null && Number.isFinite(next) && next >= min && (max === undefined || next <= max)) onChange(next);
  }} />;
}

function ColorProperty({ label, value, disabled, onChange }: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return <FormField label={label} isDisabled={disabled}>
    {(attributes) => <input {...attributes} type="color" value={normalizeColorValue(value)} onChange={(event) => onChange(event.target.value)} />}
  </FormField>;
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
  return <aside className="grid content-start gap-3 p-3" aria-label="속성 패널"><Text variant="overline" tone="secondary">조명 일괄 속성</Text><Heading as="h3" variant="card-title">{ids.length}개 선택</Heading><Text variant="body-sm" tone="secondary">수정 대상 {fixtures.length}개</Text>
    <TextField label="이름 접두어" value={prefix} maxLength={100} onChange={(value) => { setPrefix(value); setPreview(false); }} />
    <NumberField label="시작 번호" value={start} minValue={0} onChange={(value) => { if (value !== null) setStart(value); setPreview(false); }} />
    <TextField label="일괄 크기" inputMode="numeric" value={size} placeholder={mixed("size")} onChange={(value) => { setSize(value); setPreview(false); }} />
    <TextField label="일괄 정격 전력" inputMode="decimal" value={watt} placeholder={mixed("ratedWatt")} onChange={(value) => { setWatt(value); setPreview(false); }} />
    <Button disabled={readOnly || !fixtures.length || !valid || !prefix && !size && !watt} onClick={() => setPreview(true)}>속성 미리보기</Button>
    {preview && <><ul className="grid list-disc gap-1 pl-4 text-caption text-content-secondary">{fixtures.slice(0, 3).map((f, i) => <li key={f.id}>{f.name} → {prefix ? `${prefix}${String(start + i).padStart(2, "0")}` : f.name}{size && ` · 크기 ${size}`}{watt && ` · ${watt} W`}</li>)}</ul><Text variant="body-sm">{fixtures.length}개 적용 예정</Text>
      <Button variant="primary" disabled={readOnly || !valid} onClick={() => { useFloorEditorStore.getState().updateFixtureProperties(fixtures.map((f) => f.id), (_f, i) => ({ ...(prefix ? { name: `${prefix}${String(start + i).padStart(2, "0")}` } : {}), ...(size ? { size: Number(size) } : {}), ...(watt ? { ratedWatt: Number(watt) } : {}) })); setPreview(false); }}>속성 적용</Button></>}
    <Button variant="secondary" disabled={readOnly} onClick={() => useFloorEditorStore.getState().toggleFixtureLock(ids)}>선택 잠금 전환</Button>
  </aside>;
}

function normalizeColorValue(color: string) {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : themeColor("fixture-selected");
}
