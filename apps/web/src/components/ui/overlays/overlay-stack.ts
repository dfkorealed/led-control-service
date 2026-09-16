// The ref-only legacy hook cannot join React Aria's JSX FocusScope tree. This
// registry keeps it from pulling focus out of newer, portaled child dialogs.
// React Aria owns all new dialog containment; this is internal migration glue.
const overlays: object[] = [];
export function registerOverlay(token: object) {
  overlays.push(token);
  return () => {
    const top = isTopOverlay(token);
    const index = overlays.indexOf(token);
    if (index >= 0) overlays.splice(index, 1);
    return top;
  };
}
export function isTopOverlay(token: object) { return overlays.at(-1) === token; }
export function focusConnected(targets: Array<HTMLElement | null | undefined>) {
  for (const target of targets) {
    if (!target?.isConnected || target === document.body) continue;
    target.focus();
    if (document.activeElement === target) return;
  }
}
