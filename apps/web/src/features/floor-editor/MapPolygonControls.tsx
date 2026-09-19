import { CircleDashed, Trash2, X } from "lucide-react";
import { IconTooltipButton, Text } from "../../components/ui";
import type { MapEditorController } from "./use-map-editor";

export function MapPolygonControls({ editor, readOnly, onBegin }: { editor: MapEditorController; readOnly: boolean; onBegin?: () => void }) {
  if (!editor.polygon) return null;
  return <section className="grid min-w-0 gap-2 px-3 pb-3" aria-label="다각형 구멍">
    <div className="flex items-center justify-between gap-2"><Text weight="semibold">구멍</Text>
      <IconTooltipButton icon={editor.holeActive ? X : CircleDashed} label={editor.holeActive ? "구멍 입력 취소" : "구멍 추가"}
        disabled={readOnly || editor.locked} onClick={() => { if (editor.holeActive) editor.cancelHole(); else { editor.beginHole(); onBegin?.(); } }} /></div>
    {editor.polygon.geometry.holes.map((_hole, index) => <div key={index} className="flex items-center justify-between gap-2">
      <Text>구멍 {index + 1}</Text><IconTooltipButton icon={Trash2} label={`구멍 ${index + 1} 삭제`} disabled={readOnly || editor.locked} onClick={() => editor.removeHole(index)} />
    </div>)}
  </section>;
}
