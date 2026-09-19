import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button, FormField, Heading, IconTooltipButton, NumberField } from "../../components/ui";
import type { MapEditorController } from "./use-map-editor";
import { createMapElementUpdateOps } from "./map-element-editing";
import { boundsGestureTransform } from "./map-selection-transform";

export function MapSelectionProperties({ editor, readOnly }: { editor: MapEditorController; readOnly: boolean }) {
  const box = editor.bounds!;
  const [x, setX] = useState(box.minX), [y, setY] = useState(box.minY);
  const [width, setWidth] = useState(box.maxX - box.minX), [height, setHeight] = useState(box.maxY - box.minY);
  const [rotation, setRotation] = useState(0);
  const [stroke, setStroke] = useState<string | null>(null), [fill, setFill] = useState<string | null>(null);
  const [opacity, setOpacity] = useState<number | null>(null);
  const disabled = readOnly || editor.locked || editor.loadingSelection;
  return <section className="grid min-w-0 content-start gap-3 p-3" aria-label="선택 속성">
    <div className="flex items-center justify-between gap-2"><Heading as="h3" variant="card-title">{editor.selectionCount}개 도형{editor.mixed ? " · 조명 포함" : ""}</Heading>
      <IconTooltipButton icon={Trash2} label="도형 삭제" disabled={disabled} onClick={() => void editor.remove()} /></div>
    <div className="grid min-w-0 grid-cols-2 gap-2">
      <NumberField label="선택 X" value={x} isDisabled={disabled} onChange={value => { if (value !== null) setX(value); }} />
      <NumberField label="선택 Y" value={y} isDisabled={disabled} onChange={value => { if (value !== null) setY(value); }} />
      <NumberField label="선택 너비" value={width} minValue={0.001} isDisabled={disabled || editor.mixed || box.maxX === box.minX} onChange={value => { if (value !== null) setWidth(value); }} />
      <NumberField label="선택 높이" value={height} minValue={0.001} isDisabled={disabled || editor.mixed || box.maxY === box.minY} onChange={value => { if (value !== null) setHeight(value); }} />
      <NumberField label="선택 회전" value={rotation} minValue={-360} maxValue={360} isDisabled={disabled || editor.mixed} onChange={value => { if (value !== null) setRotation(value); }} />
    </div>
    <Button disabled={disabled} onClick={() => {
      try { void editor.transform(boundsGestureTransform(box, { x, y, rotation,
        scaleX: box.maxX === box.minX ? 1 : width / (box.maxX - box.minX), scaleY: box.maxY === box.minY ? 1 : height / (box.maxY - box.minY) })); }
      catch (error) { editor.reportError(error); }
    }}>선택 변환 적용</Button>
    <FormField label="선 색상" isDisabled={disabled}>{attributes => <input {...attributes} type="color" value={stroke ?? "#111827"} onChange={event => setStroke(event.target.value)} />}</FormField>
    <FormField label="채우기 색상" isDisabled={disabled}>{attributes => <input {...attributes} type="color" value={fill ?? "#ffffff"} onChange={event => setFill(event.target.value)} />}</FormField>
    <NumberField label="불투명도" value={opacity} minValue={0} maxValue={1} isDisabled={disabled} onChange={setOpacity} />
    <Button disabled={disabled || stroke === null && fill === null && opacity === null} onClick={() => {
      void editor.editSelection(element => createMapElementUpdateOps([element], original => ({ ...original, style: { ...original.style,
        ...(stroke !== null ? { strokeColor: stroke } : {}), ...(fill !== null ? { fillColor: fill } : {}), ...(opacity !== null ? { opacity } : {}) } }), editor.mapBounds ?? undefined));
    }}>도형 스타일 적용</Button>
  </section>;
}
