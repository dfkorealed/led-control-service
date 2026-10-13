import { LoaderCircle } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Text } from "./Typography";

const LoadingHost = createContext<HTMLElement | null>(null);

/** A readonly map may be inert or decorative. Its loading announcement must
 * remain outside that subtree; an outer accessible host takes precedence. */
export function MapLoadingHost({ container, children }: { container: HTMLElement | null; children: ReactNode }) {
  const inherited = useContext(LoadingHost);
  return <LoadingHost.Provider value={inherited ?? container}>{children}</LoadingHost.Provider>;
}

export function MapLoadingOverlay({ loading }: { loading: boolean }) {
  const host = useContext(LoadingHost);
  if (!loading) return null;
  const content = <div role="status" aria-live="polite" aria-busy="true"
    className="absolute inset-0 z-20 grid place-items-center bg-surface-panel/95 p-3">
    <div className="flex min-w-0 items-center gap-2">
      <LoaderCircle aria-hidden="true" className="size-5 shrink-0 animate-spin motion-reduce:animate-none text-content-secondary" />
      <Text variant="body-sm" tone="secondary">맵을 불러오는 중입니다.</Text>
    </div>
  </div>;
  return host ? createPortal(content, host) : content;
}

/** First visible paint belongs to a document visit, not every camera request.
 * A fresh token also fences A -> B -> A callbacks from the first visit to A. */
export function useMapPaintLoading(identity: string) {
  const token = useMemo(() => ({ identity }), [identity]);
  const current = useRef(token); current.current = token;
  const [settled, setSettled] = useState<typeof token | null>(null);
  const settle = useCallback(() => { if (current.current === token) setSettled(token); }, [token]);
  const onPaintReady = useCallback((ready: boolean) => { if (ready) settle(); }, [settle]);
  return { loading: settled !== token, onPaintReady, onError: settle };
}
