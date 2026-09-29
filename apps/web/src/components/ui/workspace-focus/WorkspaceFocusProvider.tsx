import { createContext, useContext, useRef, useState, type ReactNode } from "react";
interface WorkspaceFocus { active: boolean; enter(trigger: HTMLElement): void; exit(): void }
const fallback: WorkspaceFocus = { active: false, enter: () => {}, exit: () => {} };
const Context = createContext<WorkspaceFocus>(fallback);
export function useWorkspaceFocus() { return useContext(Context); }
export function WorkspaceFocusProvider({ scope, children }: { scope: string; children: ReactNode | ((focus: WorkspaceFocus) => ReactNode) }) {
  const [activeScope, setActiveScope] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const focus: WorkspaceFocus = {
    active: activeScope === scope,
    enter(trigger) { returnFocus.current = trigger; setActiveScope(scope); },
    exit() {
      setActiveScope(null);
      if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
      returnFocus.current = null;
    }
  };
  // A scope transition ends the mode synchronously and cannot revive it on a return visit.
  if (activeScope !== null && activeScope !== scope) setActiveScope(null);
  return <Context.Provider value={focus}>{typeof children === "function" ? children(focus) : children}</Context.Provider>;
}
