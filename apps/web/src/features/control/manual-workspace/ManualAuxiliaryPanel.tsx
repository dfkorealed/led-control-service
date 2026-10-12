import { createContext, useCallback, useContext, useId, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, Heading } from "../../../components/ui";

type Kind = "selection" | "more";
type Auxiliary = {
  enabled: boolean;
  active: Kind | null;
  panelId: string;
  host: HTMLDivElement | null;
  registerHost: (host: HTMLDivElement | null) => void;
  toggle: (kind: Kind, opener: HTMLButtonElement) => void;
  close: (restoreFocus?: boolean) => void;
};
const Context = createContext<Auxiliary | null>(null);

/** Manual presentation only: one nonmodal reader, no command/selection/query ownership. */
export function ManualAuxiliaryProvider({ enabled, scope, children }: { enabled: boolean; scope: string; children: ReactNode }) {
  const [opened, setOpened] = useState<{ scope: string; kind: Kind } | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const active = enabled && opened?.scope === scope ? opened.kind : null;
  const registerHost = useCallback((node: HTMLDivElement | null) => setHost(node), []);
  const close = useCallback((restoreFocus = true) => {
    setOpened(null);
    if (restoreFocus && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => { setOpened(null); }, [scope]);
  useEffect(() => {
    if (!active) return;
    // The opener remains outside the nonmodal panel. Escape must close there
    // too; nested dialogs/popovers that consume Escape retain precedence.
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); close(); }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [active, close]);
  return <Context.Provider value={{ enabled, active, panelId, host, registerHost, close,
    toggle: (kind, trigger) => {
      opener.current = trigger;
      if (active === kind) close(); else setOpened({ scope, kind });
    } }}>{children}</Context.Provider>;
}
export function useManualAuxiliary() { return useContext(Context); }

/** Keep the host and both content owners mounted while changing only visibility. */
export function ManualAuxiliaryPanel() {
  const auxiliary = useManualAuxiliary();
  if (!auxiliary) return null;
  return <section id={auxiliary.panelId} hidden={!auxiliary.active} aria-label="지도 하단 보조 패널"
    className={auxiliary.active ? "absolute inset-x-0 bottom-0 z-10 grid max-h-[75%] min-h-0 grid-rows-[auto_minmax(0,1fr)] rounded-panel border border-border-default bg-surface-panel shadow-popover" : "hidden"}
    data-manual-auxiliary-panel="" onKeyDown={event => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); event.preventDefault(); auxiliary.close(); }
    }}>
    <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-border-default px-2">
      <Heading as="h3" variant="customer-card-title">{auxiliary.active === "selection" ? "선택 조명 목록" : "제어 더보기"}</Heading>
      <Button type="button" variant="ghost" className="min-h-11! min-w-11 shrink-0" aria-label="보조 패널 닫기" onClick={() => auxiliary.close()}>닫기</Button>
    </div>
    <div ref={auxiliary.registerHost} className="min-h-0 overflow-y-auto overscroll-contain p-2" data-manual-auxiliary-body="" />
  </section>;
}
export function ManualAuxiliaryContent({ kind, children, mobileOnly = false }: { kind: Kind; children: ReactNode; mobileOnly?: boolean }) {
  const auxiliary = useManualAuxiliary();
  const inlineHost = useRef<HTMLDivElement>(null);
  const focusToRestore = useRef<HTMLElement | null>(null);
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  // React portals remount their children when their target changes. Keep one
  // target for this presentation's lifetime, moving only its DOM host between
  // the desktop inline slot and mobile reader. Feedback/history state, refs,
  // subscriptions and callbacks survive media changes; the map never moves.
  useLayoutEffect(() => {
    const destination = auxiliary?.enabled ? auxiliary.host : inlineHost.current;
    if (auxiliary && destination) {
      destination.appendChild(container);
      const focused = focusToRestore.current;
      // Moving a connected DOM subtree clears native focus even though React
      // keeps its owners. Restore only the same connected, displayed element;
      // never steal focus from another scope or reveal a closed reader.
      if (focused?.isConnected && (!auxiliary.enabled || auxiliary.active === kind)
        && !focused.closest("[hidden]")) focused.focus({ preventScroll: true });
      focusToRestore.current = null;
    }
    return () => {
      focusToRestore.current = document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
        ? document.activeElement : null;
      container.remove();
    };
  }, [auxiliary?.enabled, auxiliary?.host, Boolean(auxiliary), container]);
  if (!auxiliary) return <>{children}</>;
  const hidden = auxiliary.enabled ? auxiliary.active !== kind : mobileOnly;
  return <>
    <div ref={inlineHost} className={auxiliary.enabled ? "hidden" : "contents"} />
    {createPortal(<div hidden={hidden} className={hidden ? "hidden" : auxiliary.enabled ? "grid min-w-0 gap-2" : "contents"}
      onKeyDown={event => {
        if (auxiliary.enabled && event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation(); event.preventDefault(); auxiliary.close();
        }
      }}>{children}</div>, container)}
  </>;
}
