// The ref-only legacy hook cannot join React Aria's JSX FocusScope tree. This
// registry keeps it from pulling focus out of newer, portaled child dialogs.
// React Aria owns all new dialog containment; this is internal migration glue.
const overlays: object[] = [];
const backHandlers = new WeakMap<object, () => void>();
export function registerOverlay(token: object, onBack?: () => void) {
  overlays.push(token);
  if (onBack) backHandlers.set(token, onBack);
  return () => {
    const top = isTopOverlay(token);
    const index = overlays.indexOf(token);
    if (index >= 0) overlays.splice(index, 1);
    backHandlers.delete(token);
    return top;
  };
}
/** An overlay without a close handler still owns back (e.g. a pending dialog).
 * Do not synthesize Escape or enumerate DOM; registered refs own dismissal.
 */
export function closeTopOverlay(): boolean {
  const token = overlays.at(-1);
  if (!token) return false;
  backHandlers.get(token)?.();
  return true;
}
export function isTopOverlay(token: object) { return overlays.at(-1) === token; }
export function focusConnected(targets: Array<HTMLElement | null | undefined>) {
  for (const target of targets) {
    if (!target?.isConnected || target === document.body) continue;
    target.focus();
    if (document.activeElement === target) return;
  }
}
