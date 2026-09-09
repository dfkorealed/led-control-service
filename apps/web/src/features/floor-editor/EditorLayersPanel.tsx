import { Eye, EyeOff, Lock, Unlock, Trash2 } from "lucide-react";
import { Button } from "../../components/ui";
import { useFloorEditorStore } from "./editor-store";

export function EditorLayersPanel({ readOnly }: { readOnly: boolean }) {
  const layers = useFloorEditorStore((s) => s.layers);
  const objects = useFloorEditorStore((s) => s.state?.objects);
  return <section className="editor-properties-panel" aria-label="레이어 패널"><h3>레이어</h3>
    {([["fixtures", "조명"], ["objects", "도형"], ["background", "배경"]] as const).map(([key, label]) => <div className="editor-layer-row" key={key}><strong>{label}</strong>
      <Button variant="ghost" aria-label={`${label} ${layers[key].visible ? "숨기기" : "표시"}`} title={`${label} 표시`} onClick={() => useFloorEditorStore.getState().setLayer(key, { visible: !layers[key].visible })}>{layers[key].visible ? <Eye size={17} /> : <EyeOff size={17} />}</Button>
      <Button variant="ghost" aria-label={`${label} ${layers[key].locked ? "잠금 해제" : "잠금"}`} title={`${label} 잠금`} disabled={readOnly || key === "background"} onClick={() => useFloorEditorStore.getState().setLayer(key, { locked: !layers[key].locked })}>{layers[key].locked ? <Lock size={17} /> : <Unlock size={17} />}</Button>
    </div>)}
    {objects?.map((object, index) => <div className="editor-layer-row" key={object.id}>
      <button className="editor-layer-name" onClick={() => useFloorEditorStore.getState().selectObject(object.id)}>{object.text || `${object.type} ${index + 1}`}</button>
      <Button variant="ghost" disabled={readOnly || layers.objects.locked} aria-label={`도형 ${index + 1} 표시 전환`} title="표시 전환" onClick={() => useFloorEditorStore.getState().updateObject(object.id, { visible: !object.visible })}>{object.visible ? <Eye size={16} /> : <EyeOff size={16} />}</Button>
      <Button variant="ghost" disabled={readOnly || layers.objects.locked} aria-label={`도형 ${index + 1} 잠금 전환`} title="잠금 전환" onClick={() => useFloorEditorStore.getState().updateObject(object.id, { locked: !object.locked })}>{object.locked ? <Lock size={16} /> : <Unlock size={16} />}</Button>
      <Button variant="ghost" disabled={readOnly || object.locked || layers.objects.locked} aria-label={`도형 ${index + 1} 삭제`} title="도형 삭제" onClick={() => useFloorEditorStore.getState().removeObject(object.id)}><Trash2 size={16} /></Button>
    </div>)}
  </section>;
}
