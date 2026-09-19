import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button, ConfirmDialog, FeedbackState } from "../../components/ui";
import { canInitializeEmptyFloor, resetFloorEditorDocument } from "../../api/floor-editor-reset";
import { getFloorEditorState } from "../../api/floor-editor";
import type { FloorEditorState } from "./editor-types";

export function MapDocumentInitialization({ state, readOnly, leaseToken, leaseFence, onInitialized, onBusyChange }: {
  state: FloorEditorState; readOnly: boolean; leaseToken?: string; leaseFence?: number;
  onInitialized: (state: FloorEditorState) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState<"idle" | "pending" | "error">("idle");
  const latest = useRef(onInitialized); latest.current = onInitialized;
  const busy = useRef(onBusyChange); busy.current = onBusyChange;
  const alive = useRef(false);
  const request = useRef<{ key: string; id: string; pending: Promise<void> | null } | null>(null);
  const key = JSON.stringify([state.floor.id, state.floor.siteId, state.floor.mapRevision, leaseToken, leaseFence]);
  const currentKey = useRef(key); currentKey.current = key;
  async function initialize() {
    if (readOnly || !leaseToken || !leaseFence || state.floor.mapDocument) return;
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID(), pending: null };
    if (request.current.pending) { busy.current?.(true); return request.current.pending; }
    const current = request.current;
    setStatus("pending");
    busy.current?.(true);
    current.pending = (async () => {
      try {
        const ref = await resetFloorEditorDocument(state.floor.id, { requestId: current.id, baseRevision: state.floor.mapRevision, leaseToken, leaseFence });
        const next = await getFloorEditorState(state.floor.id);
        if (!alive.current || currentKey.current !== key) return;
        if (next.floor.siteId !== state.floor.siteId || next.floor.id !== state.floor.id || next.floor.mapDocument?.generationId !== ref.generationId || next.floor.mapRevision !== ref.revision) throw new Error("Map reset response scope mismatch");
        latest.current(next); setStatus("idle"); setConfirm(false);
      } catch { if (alive.current && currentKey.current === key) setStatus("error"); }
      finally { current.pending = null; if (currentKey.current === key) busy.current?.(false); }
    })();
    return current.pending;
  }
  useEffect(() => {
    alive.current = true;
    if (canInitializeEmptyFloor(state)) void initialize();
    return () => { alive.current = false; };
  }, [key, readOnly]);
  useEffect(() => () => { busy.current?.(false); }, []);
  if (state.floor.mapDocument) return null;
  const empty = canInitializeEmptyFloor(state);
  return <>
    <FeedbackState icon={TriangleAlert} tone={status === "error" ? "danger" : "warning"}
      title={status === "pending" ? "새 맵을 준비하고 있습니다." : status === "error" ? "맵을 준비하지 못했습니다." : "편집할 맵을 준비해주세요."}
      action={<Button disabled={readOnly || !leaseToken || !leaseFence || status === "pending"} onClick={() => { if (empty) void initialize(); else setConfirm(true); }}>{empty ? "다시 시도" : "맵 초기화"}</Button>} />
    <ConfirmDialog isOpen={confirm} onCancel={() => setConfirm(false)} isPending={status === "pending"} destructive title="이 층의 맵을 초기화할까요?"
      description="도면, 도형, 후보 슬롯과 맵 이력이 삭제됩니다. 등록 조명은 유지되며 미배치로 전환됩니다."
      confirmLabel="맵 초기화" onConfirm={() => void initialize()} />
  </>;
}
