import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type SessionStatusTone = "info" | "warning" | "danger";
export type SessionToastTone = "info" | "success" | "warning" | "danger";

export interface SessionNoticeAction {
  label: string;
  onAction(): void;
}

export interface SessionStatusItem {
  id: string;
  fingerprint: string;
  source: "site" | "gateway" | "query" | "command";
  tone: SessionStatusTone;
  title: string;
  description?: string;
  announce?: boolean;
  action?: SessionNoticeAction;
}

export interface SessionToastInput {
  id?: string;
  dedupeKey?: string;
  tone: SessionToastTone;
  title: string;
  description?: string;
  durationMs?: number;
}

export interface SessionToast extends Required<Pick<SessionToastInput, "id" | "dedupeKey" | "tone" | "title" | "durationMs">>, Pick<SessionToastInput, "description"> {
  revision: number;
  statusId?: string;
}

interface SessionStatusContextValue {
  statuses: readonly SessionStatusItem[];
  toasts: readonly SessionToast[];
  register(sourceId: string, items: readonly SessionStatusItem[]): void;
  unregister(sourceId: string): void;
  publish(input: SessionToastInput): string;
  dismiss(id: string): void;
}

const DEFAULT_TOAST_DURATION_MS = 5_000;
const MAX_VISIBLE_TOASTS = 3;
const SessionStatusContext = createContext<SessionStatusContextValue | null>(null);

export function SessionStatusProvider({ children }: { children: ReactNode }) {
  const sources = useRef(new Map<string, readonly SessionStatusItem[]>());
  const sequence = useRef(0);
  const [sourceRevision, setSourceRevision] = useState(0);
  const [toasts, setToasts] = useState<SessionToast[]>([]);

  const register = useCallback((sourceId: string, items: readonly SessionStatusItem[]) => {
    const before = aggregateStatuses(sources.current);
    sources.current.set(sourceId, items);
    const after = aggregateStatuses(sources.current);
    setSourceRevision((revision) => revision + 1);
    setToasts((current) => statusToastsAfterUpdate(current, before, after, sequence));
  }, []);

  const unregister = useCallback((sourceId: string) => {
    if (!sources.current.has(sourceId)) return;
    const before = aggregateStatuses(sources.current);
    sources.current.delete(sourceId);
    const after = aggregateStatuses(sources.current);
    setSourceRevision((revision) => revision + 1);
    const activeIds = new Set(after.map((item) => item.id));
    const resolvedIds = new Set(before.filter((item) => !activeIds.has(item.id)).map((item) => item.id));
    if (resolvedIds.size > 0) setToasts((current) => current.filter((toast) => !toast.statusId || !resolvedIds.has(toast.statusId)));
  }, []);

  const publish = useCallback((input: SessionToastInput) => {
    const id = input.id ?? input.dedupeKey ?? `toast-${++sequence.current}`;
    const dedupeKey = input.dedupeKey ?? id;
    setToasts((current) => upsertToast(current, {
      id,
      dedupeKey,
      tone: input.tone,
      title: input.title,
      description: input.description,
      durationMs: input.durationMs ?? DEFAULT_TOAST_DURATION_MS,
      revision: ++sequence.current
    }));
    return id;
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const statuses = useMemo(() => aggregateStatuses(sources.current), [sourceRevision]);
  const value = useMemo<SessionStatusContextValue>(() => ({ statuses, toasts, register, unregister, publish, dismiss }), [dismiss, publish, register, statuses, toasts, unregister]);
  return <SessionStatusContext.Provider value={value}>{children}</SessionStatusContext.Provider>;
}

export function useSessionStatus(sourceId: string, items: readonly SessionStatusItem[]) {
  const { register, unregister } = useSessionStatusContext();
  // Polling commonly creates a new array for a sustained status. Updating the
  // same source must preserve the previous fingerprint so it is not announced
  // again; unregister is reserved for source changes and unmount.
  useEffect(() => {
    register(sourceId, items);
  }, [items, register, sourceId]);
  useEffect(() => {
    return () => unregister(sourceId);
  }, [sourceId, unregister]);
}

export function useSessionToast() {
  const { publish, dismiss } = useSessionStatusContext();
  return useMemo(() => ({ publish, dismiss }), [dismiss, publish]);
}

export function useSessionStatusState() {
  return useSessionStatusContext();
}

function useSessionStatusContext() {
  const context = useContext(SessionStatusContext);
  if (!context) throw new Error("Session status components require SessionStatusProvider");
  return context;
}

function aggregateStatuses(sources: Map<string, readonly SessionStatusItem[]>) {
  const statuses = new Map<string, SessionStatusItem>();
  for (const items of sources.values()) for (const item of items) statuses.set(item.id, item);
  return [...statuses.values()];
}

function statusToastsAfterUpdate(
  current: SessionToast[],
  before: readonly SessionStatusItem[],
  after: readonly SessionStatusItem[],
  sequence: { current: number }
) {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const activeIds = new Set(after.map((item) => item.id));
  let next = current.filter((toast) => !toast.statusId || activeIds.has(toast.statusId));
  for (const item of after) {
    const previous = beforeById.get(item.id);
    if (item.announce === false || previous?.fingerprint === item.fingerprint) continue;
    next = upsertToast(next, {
      id: `status:${item.id}`,
      dedupeKey: `status:${item.id}`,
      statusId: item.id,
      tone: item.tone,
      title: item.title,
      description: item.description,
      durationMs: DEFAULT_TOAST_DURATION_MS,
      revision: ++sequence.current
    });
  }
  return next;
}

function upsertToast(current: SessionToast[], toast: SessionToast) {
  return [...current.filter((item) => item.dedupeKey !== toast.dedupeKey), toast].slice(-MAX_VISIBLE_TOASTS);
}
