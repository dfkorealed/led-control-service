import { useEffect, useRef, useState } from "react";
import { temporaryControlCreateSchema, temporaryControlEndSchema, type CreateTemporaryControlInput, type EndTemporaryControlInput, type TemporaryControlView } from "@led-control/shared/temporary-control-contracts";
import { ApiError } from "../../api/client";
import { startTemporaryControl, endTemporaryControl, getTemporaryControl, temporaryControlErrorMessage, temporaryControlIsTerminal } from "../../api/temporary-controls";

export interface TemporaryControlSessionOptions { siteId: string; principalKey: string; fixtureIds: readonly string[] }
export interface TemporaryControlSessionController {
  session: TemporaryControlView | null; controlsLocked: boolean; error: string | null;
  start(input: CreateTemporaryControlInput): Promise<void>; end(input: EndTemporaryControlInput): Promise<void>; refresh(): Promise<void>;
}
type Marker = { sessionId?: string; pendingStart?: CreateTemporaryControlInput; pendingEnd?: EndTemporaryControlInput };
type State = { key: string; epoch: number; marker: Marker | null; session: TemporaryControlView | null; error: string | null; busy: boolean; storageBlocked: boolean };
const recoveryMessage = "시간제 복구 식별자를 보존하지 못했습니다. 새 제어를 차단합니다.";
function load(key: string): Marker | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || Object.keys(value).some(name => !["sessionId", "pendingStart", "pendingEnd"].includes(name))
    || (value.sessionId !== undefined && !/^[0-9a-f-]{36}$/.test(value.sessionId))
    || (!value.sessionId && !value.pendingStart)) throw new Error("invalid recovery marker");
  if (value.pendingStart) temporaryControlCreateSchema.parse(value.pendingStart);
  if (value.pendingEnd) { temporaryControlEndSchema.parse(value.pendingEnd); if (!value.sessionId) throw new Error("end requires session"); }
  return value;
}
function initial(key: string, epoch: number): State {
  try { return { key, epoch, marker: load(key), session: null, error: null, busy: false, storageBlocked: false }; }
  catch { return { key, epoch, marker: null, session: null, error: recoveryMessage, busy: false, storageBlocked: true }; }
}

/** Keep unresolved identities separate from permanent Command persistence; clocks never settle leases. */
export function useTemporaryControlSession(options: TemporaryControlSessionOptions): TemporaryControlSessionController {
  const key = `bio-temporary-control:v1:${JSON.stringify([options.principalKey, options.siteId])}`;
  const scope = useRef({ key, epoch: 0 });
  if (scope.current.key !== key) scope.current = { key, epoch: scope.current.epoch + 1 };
  const epoch = scope.current.epoch;
  const [state, setState] = useState(() => initial(key, epoch));
  const currentState = useRef(state); currentState.current = state;
  const mounted = useRef(true);
  const writing = useRef<{ key: string; epoch: number } | null>(null);
  const observation = useRef<AbortController | null>(null);
  const owns = (owner: { key: string; epoch: number }) => mounted.current && owner.key === scope.current.key && owner.epoch === scope.current.epoch;
  const ownedState = state.key === key && state.epoch === epoch ? state : null;
  const controlsLocked = !ownedState || ownedState.storageBlocked || ownedState.busy || Boolean(ownedState.marker)
    || Boolean(ownedState.session && !temporaryControlIsTerminal(ownedState.session));

  function preserve(owner: { key: string; epoch: number }, marker: Marker | null) {
    if (!owns(owner)) return false;
    try { if (marker) localStorage.setItem(owner.key, JSON.stringify(marker)); else localStorage.removeItem(owner.key); return true; }
    catch { setState(previous => ({ ...previous, storageBlocked: true, error: recoveryMessage })); return false; }
  }
  function accept(owner: { key: string; epoch: number }, result: TemporaryControlView, expectedId?: string) {
    if (!owns(owner)) return;
    if (result.siteId !== options.siteId || (expectedId && result.id !== expectedId)) {
      setState(previous => ({ ...previous, error: "시간제 응답 신원이 일치하지 않습니다. 안전 잠금을 유지합니다." })); return;
    }
    const current = currentState.current;
    if (current.session?.id === result.id && result.sessionRevision < current.session.sessionRevision) return;
    // An accepted release cannot be downgraded by an earlier GET or erase a lost End's idempotency key.
    if (current.marker?.pendingEnd && result.sessionRevision === 1) return;
    const marker = temporaryControlIsTerminal(result) ? null : { sessionId: result.id };
    if (!preserve(owner, marker)) return;
    setState(previous => ({ ...previous, marker, session: result, error: null, busy: false }));
  }
  async function read(owner = { ...scope.current }) {
    const marker = currentState.current.key === owner.key && currentState.current.epoch === owner.epoch ? currentState.current.marker : null;
    if (!owns(owner) || !marker?.sessionId) return;
    observation.current?.abort(); const controller = new AbortController(); observation.current = controller;
    try { const result = await getTemporaryControl(options.siteId, marker.sessionId, controller.signal); if (!controller.signal.aborted) accept(owner, result, marker.sessionId); }
    catch (error) {
      if (!owns(owner) || controller.signal.aborted) return;
      setState(previous => ({ ...previous, error: temporaryControlErrorMessage(error),
        session: error instanceof ApiError && [401,403,404].includes(error.status) ? null : previous.session }));
    }
  }
  async function write(kind: "start" | "end", input: CreateTemporaryControlInput | EndTemporaryControlInput, explicitRetry = false) {
    const owner = { ...scope.current }, current = currentState.current;
    if (!owns(owner) || !options.siteId || !options.principalKey || current.storageBlocked || current.key !== owner.key || current.epoch !== owner.epoch) return;
    if (writing.current && owns(writing.current)) return;
    if (kind === "start" && !explicitRetry && (current.marker || (current.session && !temporaryControlIsTerminal(current.session)))) return;
    if (kind === "end" && !current.marker?.sessionId) return;
    let marker: Marker;
    try {
      if (kind === "start") {
        const request = temporaryControlCreateSchema.parse(input);
        marker = { pendingStart: request };
      } else marker = { sessionId: current.marker!.sessionId, pendingEnd: current.marker?.pendingEnd ?? temporaryControlEndSchema.parse(input) };
    } catch { setState(previous => ({ ...previous, error: "밝기·대상·유지시간은 유효한 정수와 정확한 식별자로 입력해 주세요." })); return; }
    if (!preserve(owner, marker)) return;
    observation.current?.abort();
    writing.current = owner;
    setState(previous => ({ ...previous, marker, busy: true, error: null }));
    try {
      const result = kind === "start"
        ? await startTemporaryControl(options.siteId, marker.pendingStart!)
        : await endTemporaryControl(options.siteId, marker.sessionId!, marker.pendingEnd!);
      accept(owner, result, marker.sessionId);
    } catch (error) {
      if (!owns(owner)) return;
      // A first-attempt 4xx can reject admission. During explicit recovery even
      // 401/403/404 cannot disprove earlier durable acceptance after a lost reply;
      // keep that exact request and lock until its original result is recovered.
      const rejected = kind === "start" && !explicitRetry && error instanceof ApiError && error.status >= 400 && error.status < 500;
      const cleared = rejected && preserve(owner, null);
      setState(previous => ({ ...previous, busy: false, marker: cleared ? null : marker, error: temporaryControlErrorMessage(error),
        session: error instanceof ApiError && [401,403,404].includes(error.status) ? null : previous.session }));
    } finally {
      if (writing.current === owner) writing.current = null;
      if (owns(owner)) setState(previous => ({ ...previous, busy: false }));
    }
  }
  useEffect(() => {
    mounted.current = true;
    const restored = initial(key, epoch); currentState.current = restored; setState(restored);
    return () => { observation.current?.abort(); };
  }, [key, epoch]);
  useEffect(() => () => { mounted.current = false; observation.current?.abort(); }, []);
  useEffect(() => {
    if (!ownedState?.marker?.sessionId || !options.siteId) return;
    void read();
    const timer = window.setInterval(() => void read(), 2000);
    return () => { clearInterval(timer); observation.current?.abort(); };
  }, [key, epoch, ownedState?.marker?.sessionId]);
  return { session: ownedState?.session ?? null, controlsLocked, error: ownedState?.error ?? null,
    start: input => write("start", input), end: input => write("end", input),
    refresh: async () => {
      const current = currentState.current;
      if (current.key !== scope.current.key || current.epoch !== scope.current.epoch) return;
      // Explicit user recovery only: neither mount nor polling replays a lost POST.
      if (current.marker?.pendingStart) await write("start", current.marker.pendingStart, true);
      else if (current.marker?.pendingEnd) await write("end", current.marker.pendingEnd, true);
      else await read();
    }
  };
}
