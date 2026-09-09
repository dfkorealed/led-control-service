import { useEffect, useMemo, useState } from "react";
import { AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter, AlignStartVertical, AlignEndVertical, AlignStartHorizontal, AlignEndHorizontal, AlignCenterVertical, AlignCenterHorizontal, Check, X } from "lucide-react";
import { Button } from "../../components/ui";
import { useFloorEditorStore } from "./editor-store";
import { alignFixtures, createPlacementPreview, type AlignMode, type PlacementOptions } from "./editor-placement";

const alignTools: Array<[AlignMode, string, typeof AlignStartVertical]> = [
  ["left", "왼쪽 정렬", AlignStartVertical], ["right", "오른쪽 정렬", AlignEndVertical],
  ["top", "위쪽 정렬", AlignStartHorizontal], ["bottom", "아래쪽 정렬", AlignEndHorizontal],
  ["center-x", "수평 가운데 정렬", AlignCenterVertical], ["center-y", "수직 가운데 정렬", AlignCenterHorizontal],
  ["distribute-x", "가로 균등 분배", AlignHorizontalDistributeCenter], ["distribute-y", "세로 균등 분배", AlignVerticalDistributeCenter]
];
export function EditorBatchPlacementPanel({ readOnly }: { readOnly: boolean }) {
  const state = useFloorEditorStore((s) => s.state);
  const ids = useFloorEditorStore((s) => s.selectedFixtureIds);
  const locked = useFloorEditorStore((s) => s.lockedFixtureIds);
  const layerLocked = useFloorEditorStore((s) => s.layers.fixtures.locked);
  const layerVisible = useFloorEditorStore((s) => s.layers.fixtures.visible);
  const preview = useFloorEditorStore((s) => s.preview);
  const [options, setOptions] = useState<PlacementOptions>({ mode: "grid", x: 60, y: 60, width: 1080, height: 680, columns: 6, rows: 4, gapX: 80, gapY: 70, angle: 0 });
  const [showError, setShowError] = useState(false);
  const fixtures = useMemo(() => state?.fixtures.filter((f) => ids.includes(f.id) && !locked.includes(f.id)) ?? [], [state?.fixtures, ids, locked]);
  const result = useMemo(() => createPlacementPreview(fixtures, options, { width: state?.floor.floorPlan?.width ?? 1200, height: state?.floor.floorPlan?.height ?? 800 }, state?.fixtures ?? []), [fixtures, options, state?.floor.floorPlan, state?.fixtures]);
  useEffect(() => { useFloorEditorStore.getState().setPreview([]); setShowError(false); }, [options, ids, locked]);
  const disabled = readOnly || layerLocked || !layerVisible || !fixtures.length;
  return <section className="editor-properties-panel" aria-label="일괄 배치">
    <h3>일괄 배치</h3><p>{fixtures.length}개 대상 · 잠금 제외 {ids.length - fixtures.length}개</p>
    <div className="editor-align-tools">{alignTools.map(([mode, label, Icon]) => <Button key={mode} variant="ghost" aria-label={label} title={label} disabled={disabled || fixtures.filter((f) => f.placementStatus !== "unplaced").length < (mode.startsWith("distribute") ? 3 : 2)} onClick={() => useFloorEditorStore.getState().placeFixtures(alignFixtures(fixtures.filter((f) => f.placementStatus !== "unplaced"), mode))}><Icon size={18} /></Button>)}</div>
    <div className="segmented-control" role="tablist" aria-label="배치 방식">{[["grid", "격자"], ["line", "선형"]].map(([mode, label]) => <button key={mode} role="tab" aria-selected={options.mode === mode} onClick={() => setOptions({ ...options, mode: mode as "grid" | "line" })}>{label}</button>)}</div>
    <div className="editor-property-grid">{([
      ["x", "시작 X"], ["y", "시작 Y"], ["width", options.mode === "grid" ? "영역 너비" : "최대 가로 이동"], ["height", options.mode === "grid" ? "영역 높이" : "최대 세로 이동"],
      ...(options.mode === "grid" ? [["columns", "열"], ["rows", "행"], ["gapX", "가로 간격"], ["gapY", "세로 간격"]] : [["gapX", "간격"], ["angle", "방향 각도"]])
    ] as Array<[keyof Omit<PlacementOptions, "mode">, string]>).map(([key, label]) => <label key={key}>{label}<input type="number" aria-label={label} value={options[key]} onChange={(e) => setOptions({ ...options, [key]: Number(e.target.value) })} /></label>)}</div>
    <Button disabled={disabled} onClick={() => { setShowError(true); useFloorEditorStore.getState().setPreview(result.points); }}>배치 미리보기</Button>
    {showError && result.error && <p role="alert" className="danger-text">{result.error}</p>}
    {preview.length > 0 && <><p role="status">{preview.length}개 배치 예정</p><div className="floor-editor-actions">
      <Button variant="secondary" onClick={() => useFloorEditorStore.getState().setPreview([])}><X size={16} />취소</Button>
      <Button variant="primary" disabled={disabled || !!result.error} onClick={() => { if (!result.error) useFloorEditorStore.getState().placeFixtures(result.points); }}><Check size={16} />배치 적용</Button>
    </div></>}
  </section>;
}
