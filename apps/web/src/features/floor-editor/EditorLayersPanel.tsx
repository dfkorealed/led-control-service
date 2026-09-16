import { Eye, EyeOff, Lock, Unlock, Trash2 } from "lucide-react";
import { Button, Heading, IconButton, Text } from "../../components/ui";
import { useFloorEditorStore } from "./editor-store";

export function EditorLayersPanel({ readOnly }: { readOnly: boolean }) {
  const layers = useFloorEditorStore((s) => s.layers);
  const objects = useFloorEditorStore((s) => s.state?.objects);
  return <section className="grid content-start gap-3 p-3" aria-label="레이어 패널"><Heading as="h3" variant="card-title">레이어</Heading>
    {([["fixtures", "조명"], ["objects", "도형"], ["background", "배경"]] as const).map(([key, label]) => <div className="flex min-w-0 items-center gap-1 border-b border-border-subtle" key={key}><Text as="strong" variant="body-sm" weight="semibold" className="min-w-0 flex-1 truncate">{label}</Text>
      <IconButton variant="ghost" size="sm" aria-label={`${label} ${layers[key].visible ? "숨기기" : "표시"}`} title={`${label} 표시`} onClick={() => useFloorEditorStore.getState().setLayer(key, { visible: !layers[key].visible })}>{layers[key].visible ? <Eye size={17} /> : <EyeOff size={17} />}</IconButton>
      <IconButton variant="ghost" size="sm" aria-label={`${label} ${layers[key].locked ? "잠금 해제" : "잠금"}`} title={`${label} 잠금`} disabled={readOnly || key === "background"} onClick={() => useFloorEditorStore.getState().setLayer(key, { locked: !layers[key].locked })}>{layers[key].locked ? <Lock size={17} /> : <Unlock size={17} />}</IconButton>
    </div>)}
    {objects?.map((object, index) => <div className="flex min-w-0 items-center gap-1 border-b border-border-subtle" key={object.id}>
      <Button variant="link" size="sm" className="min-w-0 flex-1 justify-start overflow-hidden px-0 text-left no-underline" onClick={() => useFloorEditorStore.getState().selectObject(object.id)}>{object.text || `${object.type} ${index + 1}`}</Button>
      <IconButton variant="ghost" size="sm" disabled={readOnly || layers.objects.locked} aria-label={`도형 ${index + 1} 표시 전환`} title="표시 전환" onClick={() => useFloorEditorStore.getState().updateObject(object.id, { visible: !object.visible })}>{object.visible ? <Eye size={16} /> : <EyeOff size={16} />}</IconButton>
      <IconButton variant="ghost" size="sm" disabled={readOnly || layers.objects.locked} aria-label={`도형 ${index + 1} 잠금 전환`} title="잠금 전환" onClick={() => useFloorEditorStore.getState().updateObject(object.id, { locked: !object.locked })}>{object.locked ? <Lock size={16} /> : <Unlock size={16} />}</IconButton>
      <IconButton variant="ghost" size="sm" disabled={readOnly || object.locked || layers.objects.locked} aria-label={`도형 ${index + 1} 삭제`} title="도형 삭제" onClick={() => useFloorEditorStore.getState().removeObject(object.id)}><Trash2 size={16} /></IconButton>
    </div>)}
  </section>;
}
