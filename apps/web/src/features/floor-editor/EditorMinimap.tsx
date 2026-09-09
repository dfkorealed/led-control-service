import { useEffect, useRef } from "react";
import { useFloorEditorStore } from "./editor-store";

export function EditorMinimap() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useFloorEditorStore((s) => s.state);
  const pan = useFloorEditorStore((s) => s.pan);
  const zoom = useFloorEditorStore((s) => s.zoom);
  const viewport = useFloorEditorStore((s) => s.viewport);
  const width = state?.floor.floorPlan?.width ?? 1200;
  const height = state?.floor.floorPlan?.height ?? 800;
  const scale = Math.min(160 / width, 100 / height);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, 160, 100); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width * scale, height * scale);
    ctx.fillStyle = "#6c7580";
    state?.objects.filter((o) => o.visible).forEach((o) => ctx.fillRect(o.x * scale, o.y * scale, Math.max(1, o.width * scale), Math.max(1, o.height * scale)));
    ctx.fillStyle = "#159f81";
    state?.fixtures.filter((f) => f.placementStatus !== "unplaced").forEach((f) => ctx.fillRect(f.x * scale, f.y * scale, 2, 2));
    ctx.strokeStyle = "#185ed0"; ctx.lineWidth = 2; ctx.strokeRect(-pan.x / zoom * scale, -pan.y / zoom * scale, viewport.width / zoom * scale, viewport.height / zoom * scale);
  }, [state, pan, zoom, viewport, width, height, scale]);
  return <canvas ref={canvas} width={160} height={100} className="editor-minimap" role="button" tabIndex={0} aria-label="미니맵" title="미니맵"
    onMouseDown={(e) => e.stopPropagation()} onClick={(e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      useFloorEditorStore.getState().setPan({ x: viewport.width / 2 - (e.clientX - rect.left) / scale * zoom, y: viewport.height / 2 - (e.clientY - rect.top) / scale * zoom });
    }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); useFloorEditorStore.getState().fit(); } }} />;
}
