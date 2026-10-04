import { closeTopOverlay } from "../../components/ui/overlays/overlay-stack";
import { hasDirtyEditorSentinel } from "../floor-editor/dirty-editor-history";
import { useFloorEditorStore } from "../floor-editor/editor-store";
const guards: Array<() => boolean> = [];
export function registerMobileBackGuard(handler: () => boolean): () => void {
  guards.push(handler);
  return () => { const index = guards.indexOf(handler); if (index >= 0) guards.splice(index, 1); };
}
export function handleMobileBack(): { handled: boolean; canGoBack: boolean } {
  if (closeTopOverlay() || [...guards].reverse().some((guard) => guard())) return { handled: true, canGoBack: true };
  const sentinel = hasDirtyEditorSentinel();
  if (sentinel) { history.back(); return { handled: true, canGoBack: true }; }
  // Missing registration must not authorize native exit with an unsaved editor.
  if (useFloorEditorStore.getState().isDirty) return { handled: true, canGoBack: true };
  const index: unknown = history.state?.idx;
  if (typeof index === "number" && Number.isInteger(index) && index > 0) {
    history.back(); return { handled: true, canGoBack: true };
  }
  // Unknown history ownership is not evidence of a clean router root.
  return index === 0 ? { handled: false, canGoBack: false } : { handled: true, canGoBack: true };
}
