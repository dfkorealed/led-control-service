import { useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { OverlayTriggerStateContext } from "react-aria-components";
import { registerOverlay } from "./overlay-stack";

/** Uses the owning React Aria trigger state, not DOM searches or synthetic keys.
 * Calendar/select/menu portals can share native back priority with dialogs.
 */
export function RegisteredPopoverContent({ children, onBack, disabled = false, isActive }: { children: ReactNode; onBack?: () => void; disabled?: boolean; isActive: boolean }) {
  const state = useContext(OverlayTriggerStateContext);
  const latest = useRef({ state, onBack, disabled }); latest.current = { state, onBack, disabled };
  const token = useRef({});
  useLayoutEffect(() => {
    // React Aria also renders closed popover children in its hidden collection
    // builder. Those are not visible overlays and must not steal back/focus.
    if (!isActive) return;
    const unregister = registerOverlay(token.current, () => {
      const current = latest.current;
      if (current.disabled) return;
      if (current.onBack) current.onBack(); else current.state?.close();
    });
    return () => { unregister(); };
  }, [isActive]);
  return children;
}
