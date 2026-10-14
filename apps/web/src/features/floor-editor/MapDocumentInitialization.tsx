import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button, FeedbackState, LoadingState } from "../../components/ui";
import { canInitializeEmptyFloor, resetFloorEditorDocument } from "../../api/floor-editor-reset";
import { getFloorEditorState } from "../../api/floor-editor";
import type { FloorEditorState } from "./editor-types";

export function MapDocumentInitialization({ state, readOnly, leaseToken, leaseFence, onInitialized, onBusyChange }: {
  state: FloorEditorState; readOnly: boolean; leaseToken?: string; leaseFence?: number;
  onInitialized: (state: FloorEditorState) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [status, setStatus] = useState<"idle" | "pending" | "error">("idle");
  const latest = useRef(onInitialized); latest.current = onInitialized;
  const busy = useRef(onBusyChange); busy.current = onBusyChange;
  const alive = useRef(false);
  const request = useRef<{ key: string; id: string; pending: Promise<void> | null } | null>(null);
  const key = JSON.stringify([state.floor.id, state.floor.siteId, state.floor.mapRevision, leaseToken, leaseFence]);
  const currentKey = useRef(key); currentKey.current = key;
  async function initialize() {
    if (readOnly || !leaseToken || !leaseFence || !canInitializeEmptyFloor(state)) return;
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
        latest.current(next); setStatus("idle");
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
  if (status === "pending") return <LoadingState className="shrink-0 p-2" title="새 맵을 준비하고 있습니다." />;
  return <>
    <FeedbackState icon={TriangleAlert} tone={status === "error" ? "danger" : "warning"}
      className="shrink-0 p-2 [&>div]:flex [&>div]:min-w-0 [&>div]:flex-1 [&>div]:items-center [&>div]:justify-between [&>div]:gap-2 [&>svg]:hidden compact:[&>svg]:block"
      title={!empty ? "이전 형식 맵은 초기화할 수 없습니다. 공통 맵 전환이 필요합니다." : status === "error" ? "맵을 준비하지 못했습니다." : "편집할 맵을 준비해주세요."}
      action={empty ? <Button disabled={readOnly || !leaseToken || !leaseFence} onClick={() => void initialize()}>다시 시도</Button> : undefined} />
  </>;
}
