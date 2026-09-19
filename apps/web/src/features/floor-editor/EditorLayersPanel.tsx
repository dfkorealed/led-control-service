import { ArrowDown, ArrowUp, Eye, EyeOff, Group, Lock, Plus, Ungroup, Unlock, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, Heading, IconButton, IconTooltipButton, SelectBox, Text } from "../../components/ui";
import { useFloorEditorStore } from "./editor-store";
import type { MapEditorController } from "./use-map-editor";

export function EditorLayersPanel({ readOnly, mapEditor }: { readOnly: boolean; mapEditor?: MapEditorController }) {
  const layers = useFloorEditorStore((s) => s.layers);
  const objects = useFloorEditorStore((s) => s.state?.objects);
  if (mapEditor?.document) return <CommonLayersPanel readOnly={readOnly} editor={mapEditor} />;
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

function CommonLayersPanel({ readOnly, editor }: { readOnly: boolean; editor: MapEditorController }) {
  const layers = useFloorEditorStore(s => s.mapLayers);
  const groups = useFloorEditorStore(s => s.mapGroups);
  const fixturesLayer = useFloorEditorStore(s => s.layers.fixtures);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const disabled = readOnly || busy;
  const orderedLayers = [...layers.values()].sort((a, b) => a.order - b.order);
  async function removeLayer(id: string) {
    if (!moveTarget || disabled) return;
    setBusy(true);
    try {
      const target = moveTarget;
      await editor.editQuery({ layerId: id }, element => [{ kind: "update", element: { ...element, layerId: target } }], [], [{ kind: "layer.delete", id }]);
    } catch (error) { editor.reportError(error); }
    finally { setBusy(false); }
  }
  return <section className="grid min-w-0 content-start gap-3 p-3" aria-label="레이어 패널">
    <div className="flex flex-wrap items-center justify-between gap-1"><Heading as="h3" variant="card-title">레이어</Heading>
      <IconTooltipButton icon={Plus} label="레이어 추가" disabled={disabled} onClick={() => editor.commit([{ kind: "layer.put", layer: {
        id: crypto.randomUUID(), name: `레이어 ${layers.size + 1}`, order: Math.max(-1, ...orderedLayers.map(layer => layer.order)) + 1, visible: true, locked: false
      } }])} /></div>
    <div className="flex min-w-0 items-center gap-1 border-b border-border-subtle"><Text className="min-w-0 flex-1">조명</Text>
      <IconTooltipButton icon={fixturesLayer.visible ? Eye : EyeOff} label="조명 표시 전환" onClick={() => useFloorEditorStore.getState().setLayer("fixtures", { visible: !fixturesLayer.visible })} />
      <IconTooltipButton icon={fixturesLayer.locked ? Lock : Unlock} label="조명 잠금 전환" disabled={disabled} onClick={() => useFloorEditorStore.getState().setLayer("fixtures", { locked: !fixturesLayer.locked })} /></div>
    {orderedLayers.map((layer, index) => <div key={layer.id} className="grid min-w-0 gap-1 border-b border-border-subtle pb-2">
      <Button variant="link" className="min-w-0 justify-start truncate text-left" onClick={() => editor.selectQuery({ layerId: layer.id })}>{layer.name}</Button>
      <div className="flex flex-wrap gap-1">
        <IconTooltipButton icon={layer.visible ? Eye : EyeOff} label={`${layer.name} ${layer.visible ? "숨기기" : "표시"}`} disabled={disabled}
          onClick={() => editor.commit([{ kind: "layer.put", layer: { ...layer, visible: !layer.visible } }])} />
        <IconTooltipButton icon={layer.locked ? Lock : Unlock} label={`${layer.name} ${layer.locked ? "잠금 해제" : "잠금"}`} disabled={disabled}
          onClick={() => editor.commit([{ kind: "layer.put", layer: { ...layer, locked: !layer.locked } }])} />
        {([-1, 1] as const).map(direction => <IconTooltipButton key={direction} icon={direction < 0 ? ArrowUp : ArrowDown}
          label={`${layer.name} ${direction < 0 ? "위로" : "아래로"}`} disabled={disabled || !orderedLayers[index + direction]}
          onClick={() => { const neighbor = orderedLayers[index + direction]; editor.commit([
            { kind: "layer.put", layer: { ...layer, order: neighbor.order } }, { kind: "layer.put", layer: { ...neighbor, order: layer.order } }
          ]); }} />)}
        <IconTooltipButton icon={Trash2} label={`${layer.name} 이동 후 삭제`} disabled={disabled || layer.locked || !moveTarget || moveTarget === layer.id || layers.get(moveTarget)?.locked}
          onClick={() => void removeLayer(layer.id)} />
      </div>
    </div>)}
    <SelectBox label="이동 대상 레이어" items={orderedLayers.filter(layer => !layer.locked).map(layer => ({ id: layer.id, label: layer.name }))}
      selectedKey={moveTarget} onSelectionChange={key => setMoveTarget(key === null ? null : String(key))} isDisabled={disabled} />
    <Button variant="secondary" disabled={disabled || editor.locked || !editor.selectionCount || !moveTarget || layers.get(moveTarget)?.locked}
      onClick={() => { if (moveTarget) { const target = moveTarget; void editor.editSelection(element => [{ kind: "update", element: { ...element, layerId: target } }]); } }}>선택 도형 이동</Button>
    <div className="flex flex-wrap items-center justify-between gap-1"><Heading as="h3" variant="card-title">그룹</Heading>
      <IconTooltipButton icon={Group} label="그룹 만들기" disabled={disabled || editor.locked || !editor.selectionCount} onClick={async () => {
        const id = crypto.randomUUID();
        if (await editor.editSelection(element => [{ kind: "update", element: { ...element, groupId: id } }],
          [{ kind: "group.put", group: { id, name: `그룹 ${groups.size + 1}`, parentId: null, locked: false, visible: true } }])) useFloorEditorStore.getState().selectMapGroups([id]);
      }} /></div>
    {[...groups.values()].map(group => <div key={group.id} className="grid min-w-0 gap-1 border-b border-border-subtle pb-2">
      <Button variant="link" className="min-w-0 justify-start truncate text-left" onClick={() => useFloorEditorStore.getState().selectMapGroups([group.id])}>{group.name}</Button>
      <div className="flex flex-wrap gap-1">
        <IconTooltipButton icon={group.visible ? Eye : EyeOff} label={`${group.name} 표시 전환`} disabled={disabled} onClick={() => editor.commit([{ kind: "group.put", group: { ...group, visible: !group.visible } }])} />
        <IconTooltipButton icon={group.locked ? Lock : Unlock} label={`${group.name} 잠금 전환`} disabled={disabled} onClick={() => editor.commit([{ kind: "group.put", group: { ...group, locked: !group.locked } }])} />
        <IconTooltipButton icon={Ungroup} label={`${group.name} 해제`} disabled={disabled || group.locked} onClick={async () => {
          setBusy(true);
          try { await editor.editQuery({ groupId: group.id }, element => element.groupId === group.id ? [{ kind: "update", element: { ...element, groupId: group.parentId } }] : [], [], [
            ...[...groups.values()].filter(child => child.parentId === group.id).map(child => ({ kind: "group.put" as const, group: { ...child, parentId: group.parentId } })),
            { kind: "group.delete", id: group.id }
          ]); }
          catch (error) { editor.reportError(error); } finally { setBusy(false); }
        }} />
      </div>
    </div>)}
  </section>;
}
