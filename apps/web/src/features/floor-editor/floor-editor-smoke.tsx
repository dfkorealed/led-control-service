import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import Konva from "konva";
import { MemoryRouter } from "react-router-dom";
import { createRoot } from "react-dom/client";
import "../../styles.css";
import { FloorEditorView } from "./FloorEditorView";
import { useFloorEditorStore } from "./editor-store";
import type { FloorEditorState } from "./editor-types";
import { getFloorEditorState } from "../../api/floor-editor";

/** Browser-only fixture mounts the production View, Canvas and HTTP renderer. */
export function mountFloorEditorSmoke(initial: FloorEditorState) {
  useFloorEditorStore.getState().reset();
  document.body.style.margin = "0";
  const host = document.createElement("div"); host.style.cssText = "height:100dvh;width:100%;overflow:hidden;padding:8px;box-sizing:border-box";
  document.body.replaceChildren(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryDefaults(["auth", "me"], { staleTime: Infinity });
  client.setQueryDefaults(["dashboard"], { staleTime: Infinity });
  client.setQueryData(["auth", "me"], { user: { id: "smoke-user", organizationId: "fixture-org", role: "admin", status: "active" } });
  client.setQueryData(["dashboard", "default"], { site: { id: initial.floor.siteId }, floors: [{ id: initial.floor.id, fixtures: [] }], capabilities: { read: true } });
  let savedCount = 0;
  function App() {
    const [state, setState] = useState(initial);
    return <QueryClientProvider client={client}><MemoryRouter><FloorEditorView initialState={state} userRole="admin" leaseToken="smoke-lease" leaseFence={1}
      onCancel={() => undefined} onSaved={saved => { savedCount++; setState(saved); }} onReload={async () => setState(await getFloorEditorState(initial.floor.id))} /></MemoryRouter></QueryClientProvider>;
  }
  const root = createRoot(host); root.render(<App />);
  return { dispose: () => { root.unmount(); client.clear(); }, snapshot: () => {
    const store = useFloorEditorStore.getState();
    return { overlayCount: Konva.stages.flatMap(stage => stage.find(".map-element-overlay")).length,
      elements: [...store.mapElements.values()], operations: store.mapOperations, state: store.state, dirty: store.isDirty,
      savedCount, cachedRevision: client.getQueryData<FloorEditorState>(["floor-editor", initial.floor.siteId, initial.floor.id])?.floor.mapRevision,
      historyCount: store.past.length,
      zoom: store.zoom, pan: store.pan, viewport: store.viewport, selection: store.mapSelection };
  } };
}
