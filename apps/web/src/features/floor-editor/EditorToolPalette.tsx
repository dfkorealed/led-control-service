import type { MapElement } from "@led-control/shared";
import { Ban, Circle, Hand, Minus, MousePointer2, Pentagon, Radius, Spline, Square, Triangle, Type, type LucideIcon } from "lucide-react";
import { FormField, IconTooltipButton, cn, themeColor } from "../../components/ui";

export type MapEditorTool = "select" | "pan" | MapElement["type"];
export const MAP_EDITOR_TOOL_DRAG_TYPE = "application/x-floor-editor-tool";

const tools: ReadonlyArray<{ type: MapEditorTool; label: string; icon: LucideIcon }> = [
  { type: "select", label: "선택", icon: MousePointer2 },
  { type: "pan", label: "이동", icon: Hand },
  { type: "rectangle", label: "사각형", icon: Square },
  { type: "triangle", label: "삼각형", icon: Triangle },
  { type: "line", label: "선", icon: Minus },
  { type: "text", label: "텍스트", icon: Type },
  { type: "ellipse", label: "타원", icon: Circle },
  { type: "arc", label: "호", icon: Radius },
  { type: "polyline", label: "연속선", icon: Spline },
  { type: "polygon", label: "다각형", icon: Pentagon }
];

export interface EditorToolPaletteProps {
  activeTool: MapEditorTool;
  onToolChange: (tool: MapEditorTool) => void;
  onToolDragStart?: (tool: MapEditorTool) => void;
  readOnly?: boolean;
  disabled?: boolean;
  className?: string;
  style?: MapElement["style"];
  onStyleChange?: (patch: Partial<MapElement["style"]>) => void;
}

/** Controlled tools only: the host owns gestures, element creation, permissions and history. */
export function EditorToolPalette({
  activeTool, onToolChange, onToolDragStart, readOnly = false, disabled = false, className,
  style, onStyleChange
}: EditorToolPaletteProps) {
  return <div className={cn("grid min-w-0 gap-3", className)}>
    <div role="group" aria-label="맵 편집 도구" className="flex flex-wrap gap-1">
      {tools.map(({ type, label, icon }) => {
        const shape = type !== "select" && type !== "pan";
        const unavailable = disabled || (readOnly && shape);
        return <IconTooltipButton key={type} icon={icon} label={label}
          className={activeTool === type ? "bg-action-primary-soft" : undefined}
          aria-pressed={activeTool === type} disabled={unavailable} draggable={shape && !unavailable}
          onClick={() => { if (!unavailable) onToolChange(type); }}
          onDragStart={(event) => {
            if (!shape || unavailable) { event.preventDefault(); return; }
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData(MAP_EDITOR_TOOL_DRAG_TYPE, type);
            (onToolDragStart ?? onToolChange)(type);
          }} />;
      })}
    </div>
    {style && onStyleChange ? <div className="grid min-w-0 gap-2">
      {(["strokeColor", "fillColor"] as const).map((property) => <div key={property} className="flex items-end gap-2">
        <FormField label={property === "strokeColor" ? "선 색상" : "채우기 색상"} isDisabled={disabled || readOnly}>
          {(attributes) => <input {...attributes} type="color" value={colorInputValue(style[property])}
            onChange={(event) => {
              if (!disabled && !readOnly) onStyleChange({ [property]: event.target.value });
            }} />}
        </FormField>
        <IconTooltipButton icon={Ban} label={property === "strokeColor" ? "선 없음" : "채우기 없음"}
          aria-pressed={style[property] === null} disabled={disabled || readOnly}
          onClick={() => { if (!disabled && !readOnly) onStyleChange({ [property]: null }); }} />
      </div>)}
    </div> : null}
  </div>;
}

function colorInputValue(color: string | null): string {
  // Native color controls accept RGB only. Merely displaying an alpha/null color must not rewrite it.
  return color && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color)
    ? color.slice(0, 7) : themeColor("fixture-selected");
}
