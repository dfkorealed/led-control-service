import { useState } from "react";
import { Ban, Trash2 } from "lucide-react";
import type { MapElement, MapOp } from "@led-control/shared/map-document-contracts";
import { getMapElementBounds } from "@led-control/shared/map-document-geometry";
import { Checkbox, FormField, Heading, IconTooltipButton, NumberField, Text, TextField, themeColor } from "../../components/ui";
import type { Bounds } from "./geometry";
import { createMapElementUpdateOps, getMapElementSize, resizeMapElement, uniqueMapSelection } from "./map-element-editing";

export interface MapElementPropertiesPanelProps {
  selection: MapElement[];
  onChange: (ops: MapOp[]) => void;
  onDelete: (ids: string[]) => void;
  readOnly?: boolean;
  /** Effective upstream layer/group lock. Element locks are also checked locally. */
  locked?: boolean;
  mapBounds?: Bounds;
  onError?: (error: Error) => void;
}

const names: Record<MapElement["type"], string> = {
  line: "선", rectangle: "사각형", triangle: "삼각형", ellipse: "타원",
  arc: "호", polyline: "연속선", polygon: "다각형", text: "텍스트"
};
const closedTypes = new Set<MapElement["type"]>(["rectangle", "triangle", "ellipse", "polygon"]);

function common<T>(selection: MapElement[], read: (element: MapElement) => T): T | undefined {
  const first = read(selection[0]);
  return selection.every(element => Object.is(read(element), first)) ? first : undefined;
}

/** Controlled draft editor. Group expansion, command history and persistence belong to the host. */
export function MapElementPropertiesPanel(props: MapElementPropertiesPanelProps) {
  const selection = uniqueMapSelection(props.selection);
  if (!selection.length) return null;
  return <PropertiesForm key={JSON.stringify(selection.map(element => element.id))} {...props} selection={selection} />;
}

function PropertiesForm({ selection, onChange, onDelete, readOnly = false, locked = false,
  mapBounds, onError }: MapElementPropertiesPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
  const disabled = readOnly || locked || selection.some(element => element.locked);
  const type = common(selection, element => element.type);
  const report = (cause: unknown) => {
    const failure = cause instanceof Error ? cause : new Error("도형을 수정할 수 없습니다.");
    setError(failure.message);
    // React Aria keeps an in-progress numeric string; remount rejected fields to restore canonical values.
    setResetVersion(version => version + 1);
    onError?.(failure);
  };
  const change = (update: (element: MapElement) => MapElement) => {
    if (disabled) return;
    try {
      const ops = createMapElementUpdateOps(selection, update, mapBounds);
      if (ops.length) onChange(ops);
      setError(null);
    } catch (cause) { report(cause); }
  };
  const number = (label: string, read: (element: MapElement) => number,
    write: (element: MapElement, value: number) => MapElement, options: { min?: number; max?: number; disabled?: boolean } = {}) => {
    const value = common(selection, read);
    return <NumberField key={label} label={label} isDisabled={disabled || options.disabled}
      value={value ?? null} placeholder={value === undefined ? "혼합" : undefined}
      minValue={options.min} maxValue={options.max} formatOptions={{ maximumFractionDigits: 6 }}
      onChange={next => { if (next !== null) change(element => write(element, next)); }} />;
  };
  const color = (property: "strokeColor" | "fillColor", label: string) => {
    const value = common(selection, element => element.style[property]);
    return <div key={property} className="flex min-w-0 items-end gap-2">
      <FormField label={label} className="min-w-0 flex-1" isDisabled={disabled} description={value === undefined ? "혼합" : undefined}>
        {attributes => <input {...attributes} type="color"
          // Native RGB controls cannot express null/alpha; display alone must not change the stored color.
          value={value ? value.slice(0, 7) : themeColor("fixture-selected")}
          onChange={event => change(element => ({ ...element, style: { ...element.style, [property]: event.target.value } }))} />}
      </FormField>
      <IconTooltipButton icon={Ban} label={property === "strokeColor" ? "선 없음" : "채우기 없음"}
        aria-pressed={value === null} disabled={disabled}
        onClick={() => change(element => ({ ...element, style: { ...element.style, [property]: null } }))} />
    </div>;
  };

  return <aside className="grid min-w-0 content-start gap-3 p-3" aria-label="도형 속성" onKeyDown={event => {
    // Leave native text deletion intact, but do not let the canvas treat it as a shape-delete shortcut.
    if ((event.key === "Backspace" || event.key === "Delete") && event.target instanceof HTMLElement &&
      event.target.closest("input, textarea, [contenteditable], [role='textbox']")) event.stopPropagation();
  }}>
    <div className="flex min-w-0 items-center justify-between gap-2">
      <Heading as="h3" variant="card-title">{selection.length > 1 ? `${selection.length}개 도형` : names[selection[0].type]}</Heading>
      <IconTooltipButton icon={Trash2} label="도형 삭제" disabled={disabled} onClick={() => {
        if (disabled) return;
        try { onDelete(selection.map(element => element.id)); setError(null); }
        catch (cause) { report(cause); }
      }} />
    </div>
    {disabled ? <Text variant="caption" tone="secondary">{readOnly ? "읽기 전용" : "잠금 상태"}</Text> : null}
    <div key={resetVersion} className="grid min-w-0 gap-3">
      <div className="grid min-w-0 grid-cols-2 gap-2">
        {number("X 위치", element => getMapElementBounds(element).minX, (element, x) => ({ ...element,
          transform: { ...element.transform, x: element.transform.x + x - getMapElementBounds(element).minX } }))}
        {number("Y 위치", element => getMapElementBounds(element).minY, (element, y) => ({ ...element,
          transform: { ...element.transform, y: element.transform.y + y - getMapElementBounds(element).minY } }))}
        {number("너비", element => getMapElementSize(element).width, (element, width) => resizeMapElement(element, { width }),
          { disabled: selection.some(element => getMapElementSize(element).width === 0) })}
        {number("높이", element => getMapElementSize(element).height, (element, height) => resizeMapElement(element, { height }),
          { disabled: selection.some(element => getMapElementSize(element).height === 0) })}
        {number("회전", element => element.transform.rotation, (element, rotation) => ({ ...element,
          transform: { ...element.transform, rotation } }), { min: -360, max: 360 })}
        {number("불투명도", element => element.style.opacity, (element, opacity) => ({ ...element,
          style: { ...element.style, opacity } }), { min: 0, max: 1 })}
      </div>
      {color("strokeColor", type === "text" ? "글자 색상" : "선 색상")}
      {selection.every(element => closedTypes.has(element.type)) ? color("fillColor", "채우기 색상") : null}
      {type !== "text" ? number("선 두께", element => element.style.strokeWidth, (element, strokeWidth) => ({
        ...element, style: { ...element.style, strokeWidth }
      }), { min: 0 }) : null}
      {type === "line" ? <div className="grid min-w-0 grid-cols-2 gap-2">
        {(["start", "end"] as const).flatMap(endpoint => (["x", "y"] as const).map(axis => number(
          `${endpoint === "start" ? "시작" : "끝"} ${axis.toUpperCase()}`,
          element => element.type === "line" ? element.geometry[endpoint][axis] : 0,
          (element, value) => element.type === "line" ? { ...element, geometry: { ...element.geometry,
            [endpoint]: { ...element.geometry[endpoint], [axis]: value } } } : element
        )))}
      </div> : null}
      {type === "ellipse" ? <div className="grid min-w-0 grid-cols-2 gap-2">
        {(["radiusX", "radiusY"] as const).map(axis => number(axis === "radiusX" ? "가로 반지름" : "세로 반지름",
          element => element.type === "ellipse" ? element.geometry[axis] : 0,
          (element, value) => element.type === "ellipse" ? { ...element, geometry: { ...element.geometry, [axis]: value } } : element))}
      </div> : null}
      {type === "arc" ? <>
        {(["radius", "startAngle", "endAngle"] as const).map(property => number(
          { radius: "반지름", startAngle: "시작 각도", endAngle: "끝 각도" }[property],
          element => element.type === "arc" ? element.geometry[property] : 0,
          (element, value) => element.type === "arc" ? { ...element, geometry: { ...element.geometry, [property]: value } } : element))}
        <Checkbox label="반시계 방향" isDisabled={disabled}
          isSelected={common(selection, element => element.type === "arc" && element.geometry.counterClockwise) ?? false}
          isIndeterminate={common(selection, element => element.type === "arc" && element.geometry.counterClockwise) === undefined}
          onChange={counterClockwise => change(element => element.type === "arc" ? { ...element,
            geometry: { ...element.geometry, counterClockwise } } : element)} />
      </> : null}
      {type === "text" ? <>
        <TextField label="텍스트" isDisabled={disabled}
          value={common(selection, element => element.type === "text" ? element.geometry.text : "") ?? ""}
          placeholder={common(selection, element => element.type === "text" ? element.geometry.text : "") === undefined ? "혼합" : undefined}
          onChange={text => change(element => element.type === "text" ? { ...element, geometry: { ...element.geometry, text } } : element)} />
        {number("글자 크기", element => element.type === "text" ? element.geometry.fontSize : 0,
          (element, fontSize) => element.type === "text" ? { ...element, geometry: { ...element.geometry, fontSize } } : element)}
      </> : null}
    </div>
    {error ? <div role="alert" className="break-words text-caption text-status-danger-foreground">{error}</div> : null}
  </aside>;
}
