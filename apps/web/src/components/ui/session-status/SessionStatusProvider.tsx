import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type ReactNode } from "react";

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

export interface SessionRecentNotification extends SessionToast {
  isRead: boolean;
}

interface SessionStatusContextValue {
  recentNotifications: readonly SessionRecentNotification[];
  recentUnreadCount: number;
  markRecentRead(id: string): void;
  // These statuses describe the current screen and its actions. Durable alarm
  // counts belong to the authenticated, site-scoped monitoring incident GET.
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

// Each scope owns its mutable registration/timer maps. Replacing this store
// during render resets notifications before child effects re-register, while
// leaving consumer DOM and command owners mounted. Old closures retain only
// their old maps; scoped setters reject their asynchronous writes.
export function SessionStatusProvider({ children, scope }: { children: ReactNode; scope?: string }) {
  const generation = useMemo(() => ({
    sources: { current: new Map<string, readonly SessionStatusItem[]>() },
    pendingUnregistrations: { current: new Map<string, object>() },
    timers: { current: new Map<string, { revision: number; timer: number }>() }
  }), [scope]);
  const { sources, pendingUnregistrations, timers } = generation;
  const sequence = useRef(0);
  const [sourceRevision, setSourceRevision] = useScopedState(generation, 0);
  const [toasts, setToasts] = useScopedState<SessionToast[]>(generation, []);
  const [recentNotifications, setRecentNotifications] = useScopedState<SessionRecentNotification[]>(generation, []);
  const remember = useCallback((events: readonly SessionToast[]) => {
    setRecentNotifications(current => [...current, ...events.map(event => ({ ...event, id: `recent:${event.revision}`, isRead: false }))].slice(-50));
  }, [setRecentNotifications]);
  const markRecentRead = useCallback((id: string) => {
    setRecentNotifications(current => current.map(item => item.id === id ? { ...item, isRead: true } : item));
  }, [setRecentNotifications]);
  // Expiry belongs to the provider, so hiding/unmounting the visual toast region
  // cannot revive old notices after a breakpoint change. Preserve other timers.
  useEffect(() => {
    for (const [id, entry] of timers.current) {
      if (!toasts.some(toast => toast.id === id && toast.revision === entry.revision)) {
        window.clearTimeout(entry.timer); timers.current.delete(id);
      }
    }
    for (const toast of toasts) if (!timers.current.has(toast.id)) {
      const timer = window.setTimeout(() => setToasts(current => current.filter(item => item.id !== toast.id || item.revision !== toast.revision)), toast.durationMs);
      timers.current.set(toast.id, { revision: toast.revision, timer });
    }
  }, [toasts, timers, setToasts]);
  useEffect(() => () => { for (const entry of timers.current.values()) window.clearTimeout(entry.timer); timers.current.clear(); }, [timers]);

  const register = useCallback((sourceId: string, items: readonly SessionStatusItem[]) => {
    pendingUnregistrations.current.delete(sourceId);
    const before = aggregateStatuses(sources.current);
    sources.current.set(sourceId, items);
    const after = aggregateStatuses(sources.current);
    setSourceRevision((revision) => revision + 1);
    const events = statusToastsAfterUpdate([], before, after, sequence);
    remember(events);
    const activeIds = new Set(after.map(item => item.id));
    setToasts(current => events.reduce(upsertToast, current.filter(toast => !toast.statusId || activeIds.has(toast.statusId))));
  }, [remember, sources, pendingUnregistrations, setSourceRevision, setToasts]);

  const unregister = useCallback((sourceId: string) => {
    if (!sources.current.has(sourceId)) return;
    const removal = {};
    pendingUnregistrations.current.set(sourceId, removal);
    // StrictMode replays cleanup/setup synchronously. Keep the previous source
    // until that replay can renew it, rather than treating replay as resolution.
    // Actual empty-item updates still resolve immediately; a real unmount loses
    // its source at the microtask boundary, so later recurrence remains new.
    queueMicrotask(() => {
      if (pendingUnregistrations.current.get(sourceId) !== removal) return;
      pendingUnregistrations.current.delete(sourceId);
      const before = aggregateStatuses(sources.current);
      sources.current.delete(sourceId);
      const after = aggregateStatuses(sources.current);
      setSourceRevision((revision) => revision + 1);
      const activeIds = new Set(after.map((item) => item.id));
      const resolvedIds = new Set(before.filter((item) => !activeIds.has(item.id)).map((item) => item.id));
      if (resolvedIds.size > 0) setToasts((current) => current.filter((toast) => !toast.statusId || !resolvedIds.has(toast.statusId)));
    });
  }, [sources, pendingUnregistrations, setSourceRevision, setToasts]);

  const publish = useCallback((input: SessionToastInput) => {
    const id = input.id ?? input.dedupeKey ?? `toast-${++sequence.current}`;
    const dedupeKey = input.dedupeKey ?? id;
    const toast: SessionToast = {
      id,
      dedupeKey,
      tone: input.tone,
      title: input.title,
      description: input.description,
      durationMs: input.durationMs ?? DEFAULT_TOAST_DURATION_MS,
      revision: ++sequence.current
    };
    remember([toast]);
    setToasts(current => upsertToast(current, toast));
    return id;
  }, [remember, setToasts]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, [setToasts]);

  const statuses = useMemo(() => aggregateStatuses(sources.current), [sourceRevision, sources]);
  const value = useMemo<SessionStatusContextValue>(() => ({ statuses, toasts, recentNotifications, recentUnreadCount: recentNotifications.filter(item => !item.isRead).length, markRecentRead, register, unregister, publish, dismiss }), [dismiss, publish, register, statuses, toasts, unregister, recentNotifications, markRecentRead]);
  return <SessionStatusContext.Provider value={value}>{children}</SessionStatusContext.Provider>;
}

function useScopedState<T>(generation: object, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState(() => ({ generation, value: initial }));
  if (state.generation !== generation) setState({ generation, value: initial });
  const update = useCallback<Dispatch<SetStateAction<T>>>(next => {
    setState(current => current.generation !== generation ? current : {
      generation,
      value: typeof next === "function" ? (next as (previous: T) => T)(current.value) : next
    });
  }, [generation]);
  return [state.generation === generation ? state.value : initial, update];
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
    next = [...next, {
      id: `status:${item.id}`,
      dedupeKey: `status:${item.id}`,
      statusId: item.id,
      tone: item.tone,
      title: item.title,
      description: item.description,
      durationMs: DEFAULT_TOAST_DURATION_MS,
      revision: ++sequence.current
    }];
  }
  return next;
}

function upsertToast(current: SessionToast[], toast: SessionToast) {
  return [...current.filter((item) => item.dedupeKey !== toast.dedupeKey), toast].slice(-MAX_VISIBLE_TOASTS);
}
