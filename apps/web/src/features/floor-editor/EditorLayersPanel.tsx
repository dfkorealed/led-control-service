import { ArrowDown, ArrowUp, Eye, EyeOff, Group, Lock, Plus, Ungroup, Unlock, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, ConfirmDialog, Heading, IconButton, IconTooltipButton, SelectBox, Text, TextField, panelPaddingClass } from "../../components/ui";
import { LayerTreeRow } from "../../components/ui/LayerTreeRow";
import type { MapSelectionInput } from "../../api/map-document";
import { mapGroupContains } from "./map-editor-selection";
import { useFloorEditorStore } from "./editor-store";
import type { MapEditorController } from "./use-map-editor";

export function EditorLayersPanel({ readOnly, mapEditor }: { readOnly: boolean; mapEditor?: MapEditorController }) {
  const layers = useFloorEditorStore((s) => s.layers);
  const objects = useFloorEditorStore((s) => s.state?.objects);
  if (mapEditor?.document) return <CommonLayersPanel readOnly={readOnly} editor={mapEditor} />;
  return <section className={`grid content-start gap-3 ${panelPaddingClass("regular")}`} aria-label="레이어 패널"><Heading as="h3" variant="customer-card-title">레이어</Heading>
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
  const placedCount = useFloorEditorStore(s => s.state?.fixtures.filter(f => f.placementStatus !== "unplaced").length ?? 0);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rename, setRename] = useState<{ kind: "layer" | "group"; id: string; name: string } | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const disabled = readOnly || busy || editor.preparing;
  const orderedLayers = [...layers.values()].sort((a, b) => a.order - b.order);
  const queryChecked = (filter: MapSelectionInput) => editor.selectedQueries.some(value => JSON.stringify(value) === JSON.stringify(filter));
  const selectedName = rename?.kind === "layer" ? layers.get(rename.id) : rename ? groups.get(rename.id) : null;
  const renameLocked = selectedName?.locked || rename?.kind === "group" && mapGroupContains(rename.id, new Set([...groups.values()].filter(group => group.locked).map(group => group.id)), groups);
  async function removeLayer() {
    if (!removeId || !moveTarget || disabled) return;
    const layer = layers.get(removeId), target = layers.get(moveTarget);
    if (!layer || layer.locked || !target || target.locked || target.id === layer.id) return;
    setBusy(true);
    try { await editor.editQuery({ layerId: layer.id }, element => [{ kind: "update", element: { ...element, layerId: target.id } }], [], [{ kind: "layer.delete", id: layer.id }]); }
    catch (error) { editor.reportError(error); }
    finally { setBusy(false); setRemoveId(null); }
  }
  async function ungroup(id: string) {
    const group = groups.get(id);
    if (!group || disabled || mapGroupContains(id, new Set([...groups.values()].filter(g => g.locked).map(g => g.id)), groups)) return;
    setBusy(true);
    try { await editor.editQuery({ groupId: id }, element => element.groupId === id ? [{ kind: "update", element: { ...element, groupId: group.parentId } }] : [], [], [
      ...[...groups.values()].filter(child => child.parentId === id).map(child => ({ kind: "group.put" as const, group: { ...child, parentId: group.parentId } })),
      { kind: "group.delete", id }
    ]); } catch (error) { editor.reportError(error); } finally { setBusy(false); }
  }
  return <section className={`grid min-w-0 content-start gap-2 ${panelPaddingClass("regular")}`} aria-label="레이어 패널">
    <div className="flex items-center justify-between gap-1"><Heading as="h3" variant="customer-card-title">레이어</Heading>
      <IconTooltipButton size="sm" icon={Plus} label="레이어 추가" disabled={disabled} onClick={() => editor.commit([{ kind: "layer.put", layer: {
        id: crypto.randomUUID(), name: `레이어 ${layers.size + 1}`, order: Math.max(-1, ...orderedLayers.map(layer => layer.order)) + 1, visible: true, locked: false
      } }])} /></div>
    <LayerTreeRow name="조명" selectionLabel="조명 배치 전체 선택" checked={placedCount > 0 && editor.fixtureCount === placedCount} indeterminate={editor.fixtureCount > 0 && editor.fixtureCount < placedCount} visible={fixturesLayer.visible} locked={fixturesLayer.locked} disabled={disabled}
      onSelect={editor.selectFixtureLayer} onVisible={() => useFloorEditorStore.getState().setLayer("fixtures", { visible: !fixturesLayer.visible })}
      onLock={() => useFloorEditorStore.getState().setLayer("fixtures", { locked: !fixturesLayer.locked })} />
    {orderedLayers.map((layer, index) => <LayerTreeRow key={layer.id} name={layer.name} selectionLabel={`${layer.name} 레이어 내 도형 선택`} checked={queryChecked({ layerId: layer.id })}
      visible={layer.visible} locked={layer.locked} disabled={disabled} onSelect={checked => editor.toggleQuery({ layerId: layer.id }, checked)}
      onVisible={() => editor.commit([{ kind: "layer.put", layer: { ...layer, visible: !layer.visible } }])}
      onLock={() => editor.commit([{ kind: "layer.put", layer: { ...layer, locked: !layer.locked } }])}
      menu={[
        { id: "rename", label: "이름 변경", isDisabled: layer.locked },
        { id: "up", label: `${layer.name} 위로`, isDisabled: layer.locked || !orderedLayers[index - 1] || orderedLayers[index - 1]?.locked },
        { id: "down", label: `${layer.name} 아래로`, isDisabled: layer.locked || !orderedLayers[index + 1] || orderedLayers[index + 1]?.locked },
        { id: "remove", label: `${layer.name} 이동 후 삭제`, isDisabled: layer.locked || !moveTarget || moveTarget === layer.id || !layers.has(moveTarget) || layers.get(moveTarget)?.locked }
      ]} onAction={action => {
        if (layer.locked) return;
        if (action === "rename") setRename({ kind: "layer", id: layer.id, name: layer.name });
        else if (action === "remove") setRemoveId(layer.id);
        else { const neighbor = orderedLayers[index + (action === "up" ? -1 : 1)];
          if (neighbor && !neighbor.locked) editor.commit([{ kind: "layer.put", layer: { ...layer, order: neighbor.order } }, { kind: "layer.put", layer: { ...neighbor, order: layer.order } }]);
        }
      }} />)}
    <SelectBox label="이동 대상 레이어" placeholder="레이어 선택" items={orderedLayers.filter(layer => !layer.locked).map(layer => ({ id: layer.id, label: layer.name }))}
      selectedKey={moveTarget} onSelectionChange={key => setMoveTarget(key === null ? null : String(key))} isDisabled={disabled} />
    <Button variant="secondary" disabled={disabled || editor.locked || !editor.shapeCount || !moveTarget || !layers.has(moveTarget) || layers.get(moveTarget)?.locked}
      onClick={() => { if (moveTarget) { const target = moveTarget; void editor.editSelection(element => [{ kind: "update", element: { ...element, layerId: target } }]); } }}>선택 도형 이동</Button>
    <IconTooltipButton size="sm" icon={Trash2} label="선택 전체 삭제" disabled={disabled || editor.locked || !editor.selectionCount} onClick={editor.requestRemove} />
    <div className="flex items-center justify-between gap-1"><Heading as="h3" variant="customer-card-title">그룹</Heading>
      <IconTooltipButton size="sm" icon={Group} label="그룹 만들기" disabled={disabled || editor.locked || !editor.shapeCount} onClick={async () => {
        const id = crypto.randomUUID();
        if (await editor.editSelection(element => [{ kind: "update", element: { ...element, groupId: id } }],
          [{ kind: "group.put", group: { id, name: `그룹 ${groups.size + 1}`, parentId: null, locked: false, visible: true } }])) useFloorEditorStore.getState().selectMapGroups([id]);
      }} /></div>
    {[...groups.values()].map(group => {
      const inheritedLock = mapGroupContains(group.id, new Set([...groups.values()].filter(g => g.locked).map(g => g.id)), groups);
      return <LayerTreeRow key={group.id} name={group.name} selectionLabel={`${group.name} 그룹 내 도형 선택`} checked={queryChecked({ groupId: group.id })}
        visible={group.visible} locked={group.locked} disabled={disabled} onSelect={checked => editor.toggleQuery({ groupId: group.id }, checked)}
        onVisible={() => { if (!inheritedLock) editor.commit([{ kind: "group.put", group: { ...group, visible: !group.visible } }]); }}
        onLock={() => editor.commit([{ kind: "group.put", group: { ...group, locked: !group.locked } }])}
        menu={[{ id: "rename", label: "이름 변경", isDisabled: inheritedLock }, { id: "ungroup", label: `${group.name} 해제`, isDisabled: inheritedLock }]}
        onAction={action => { if (inheritedLock) return; if (action === "rename") setRename({ kind: "group", id: group.id, name: group.name }); else void ungroup(group.id); }} />;
    })}
    {rename && <ConfirmDialog open title="이름 변경" confirmLabel="이름 저장" confirmDisabled={disabled || !selectedName || Boolean(renameLocked) || !rename.name.trim() || rename.name.trim().length > 200}
      onCancel={() => setRename(null)} onConfirm={() => {
        if (disabled || !selectedName || renameLocked || !rename.name.trim()) return;
        const name = rename.name.trim();
        const saved = rename.kind === "layer"
          ? editor.commit([{ kind: "layer.put", layer: { ...layers.get(rename.id)!, name } }])
          : editor.commit([{ kind: "group.put", group: { ...groups.get(rename.id)!, name } }]);
        if (saved) setRename(null);
      }}><TextField label="이름" value={rename.name} onChange={name => setRename({ ...rename, name })} isDisabled={disabled} /></ConfirmDialog>}
    {removeId && <ConfirmDialog open title="레이어 삭제" destructive confirmLabel="이동 후 삭제" isPending={busy}
      confirmDisabled={disabled || !layers.has(removeId) || layers.get(removeId)?.locked || !moveTarget || moveTarget === removeId || !layers.has(moveTarget) || layers.get(moveTarget)?.locked}
      onCancel={() => setRemoveId(null)} onConfirm={() => void removeLayer()}><Text>도형을 선택한 레이어로 이동하고 기존 레이어를 삭제합니다.</Text></ConfirmDialog>}
  </section>;
}
