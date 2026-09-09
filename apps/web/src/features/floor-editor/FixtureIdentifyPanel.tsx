import { useEffect, useRef, useState } from "react";
import { Lightbulb, Square, SkipForward, Check } from "lucide-react";
import type { FixtureIdentifyResponse } from "@led-control/shared";
import { identifyFixture, acquireFloorEditorLease } from "../../api/floor-editor";
import { ApiError } from "../../api/client";
import { Button } from "../../components/ui";
import { useFloorEditorStore } from "./editor-store";

interface ActiveSession { floorId: string; fixtureId: string; sessionId: string; expiresAt: number; leaseToken: string; leaseFence: number }
const reasonLabels: Record<string, string> = {
  gateway_starting: "게이트웨이 시작 중입니다. 잠시 후 다시 시도하세요.", attention_timeout: "장비 응답을 받지 못했습니다.",
  attention_unsupported: "장비가 식별 점멸을 지원하지 않습니다.", fixture_not_registered: "장비 등록 상태를 확인하세요.",
  command_expired: "명령 유효 시간이 지났습니다.", stale_session: "이전 식별 세션입니다.", gateway_busy: "게이트웨이가 다른 조명을 확인 중입니다."
};
function outcomeLabel(result: FixtureIdentifyResponse) {
  if (result.status === "attention_confirmed") return "점멸 응답 확인";
  if (result.status === "stopped") return "점멸 중지 확인";
  if (result.status === "rejected") return reasonLabels[result.reason ?? ""] ?? "식별 요청이 거부되었습니다.";
  return `응답 미확인 · ${reasonLabels[result.reason ?? ""] ?? "점멸 여부를 확인할 수 없습니다."}`;
}
function errorReason(error: ApiError): string {
  const body = error.body;
  return body && typeof body === "object" && "message" in body && typeof body.message === "string"
    ? body.message
    : error.message;
}

export function FixtureIdentifyPanel({ floorId, readOnly, leaseToken, leaseFence }: { floorId: string; readOnly: boolean; leaseToken?: string; leaseFence?: number }) {
  const state = useFloorEditorStore((s) => s.state);
  const selection = useFloorEditorStore((s) => s.selection);
  const fixture = selection?.kind === "fixture" ? state?.fixtures.find((f) => f.id === selection.id) : undefined;
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const active = useRef<ActiveSession | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const currentProps = useRef({ readOnly, floorId }); currentProps.current = { readOnly, floorId };
  const publish = (value: ActiveSession | null) => { active.current = value; if (mounted.current) setSession(value); };
  async function stopActive(): Promise<boolean> {
    const target = active.current;
    if (!target) return true;
    if (Date.now() >= target.expiresAt) { publish(null); return true; }
    try {
      const result = await identifyFixture(target.floorId, target.fixtureId, { action: "stop", sessionId: target.sessionId, leaseToken: target.leaseToken, leaseFence: target.leaseFence });
      if (mounted.current) setMessage(outcomeLabel(result));
      if (result.status === "stopped" || Date.now() >= target.expiresAt) { if (active.current?.sessionId === target.sessionId) publish(null); return true; }
    } catch { if (mounted.current) setMessage("중지 응답 미확인 · 장비 자체 만료 대기 중"); }
    return false;
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void stopActive(); };
  }, [floorId]);
  useEffect(() => { if (readOnly) void stopActive(); }, [readOnly]);
  useEffect(() => {
    if (!session) { setRemaining(0); return; }
    const tick = () => setRemaining(Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000)));
    tick(); const timer = window.setInterval(tick, 250); return () => window.clearInterval(timer);
  }, [session]);

  async function start(fixtureId: string) {
    if (currentProps.current.readOnly || !leaseToken || !leaseFence || useFloorEditorStore.getState().state?.floor.id !== floorId) return;
    if (!await stopActive()) return;
    const next: ActiveSession = { floorId, fixtureId, sessionId: crypto.randomUUID(), expiresAt: Date.now() + 10000, leaseToken, leaseFence };
    publish(next);
    try {
      let result: FixtureIdentifyResponse;
      try {
        result = await identifyFixture(floorId, fixtureId, { action: "start", sessionId: next.sessionId, leaseToken, leaseFence });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || !errorReason(error).includes("requires renewal")) throw error;
        const renewed = await acquireFloorEditorLease(floorId, leaseToken);
        if (!renewed.editable || renewed.token !== leaseToken || renewed.fence !== leaseFence || currentProps.current.readOnly || !mounted.current) throw error;
        next.sessionId = crypto.randomUUID(); next.expiresAt = Date.now() + 10000;
        result = await identifyFixture(floorId, fixtureId, { action: "start", sessionId: next.sessionId, leaseToken, leaseFence });
      }
      const current = { ...next, sessionId: result.sessionId, expiresAt: Date.parse(result.expiresAt) };
      publish(result.status === "stopped" ? null : current);
      if (mounted.current) setMessage(outcomeLabel(result));
      // A request may finish after navigation/lease loss. Stop its returned session too;
      // a prior cleanup stop can have raced the still-in-flight start request.
      if (!mounted.current || currentProps.current.readOnly || currentProps.current.floorId !== floorId) await stopActive();
    } catch (error) {
      if (mounted.current) setMessage(error instanceof ApiError ? `식별 요청 실패 (${error.status}) · ${errorReason(error)}` : "식별 응답 미확인 · 장비 자체 만료 대기 중");
    }
  }
  async function run(action: () => Promise<void>) {
    if (busy.current || readOnly) return;
    busy.current = true; setPending(true);
    try { await action(); } finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  async function next(skip: boolean) {
    if (!await stopActive()) return;
    const store = useFloorEditorStore.getState();
    const fixtures = store.state?.fixtures ?? [];
    const index = fixtures.findIndex((f) => f.id === fixture?.id);
    const target = fixtures[index + 1];
    if (!target) { setMessage("마지막 조명입니다."); return; }
    store.selectFixture(target.id); store.fit(true);
    if (!skip) await start(target.id);
  }
  if (!fixture && !session) return null;
  return <section className="editor-properties-panel" aria-label="조명 위치 확인"><h3>조명 위치 확인</h3>
    <strong>{fixture?.name ?? state?.fixtures.find((f) => f.id === session?.fixtureId)?.name}</strong>
    {session && session.fixtureId !== fixture?.id && <p>진행 중인 식별 대상: {state?.fixtures.find((f) => f.id === session.fixtureId)?.name}</p>}
    {message && <p role="status">{message}</p>}
    {session && <p>{remaining > 0 ? `장비 자체 만료까지 최대 ${remaining}초` : "명령 유효 시간 종료 · 장비 자체 만료 시점 경과"}</p>}
    <div className="floor-editor-actions">
      <Button disabled={readOnly || pending || !fixture || fixture.status !== "online" || !leaseToken} onClick={() => void run(() => start(fixture!.id))}><Lightbulb size={16} />{message ? "다시 확인" : "확인 시작"}</Button>
      <Button disabled={readOnly || pending || !session || remaining === 0} onClick={() => void run(async () => { await stopActive(); })}><Square size={16} />중지</Button>
      <Button disabled={readOnly || pending || !fixture || fixture.placementStatus === "unplaced"} onClick={() => useFloorEditorStore.getState().updateFixture(fixture!.id, { positionVerified: true })}><Check size={16} />위치 확인</Button>
      <Button disabled={readOnly || pending || !fixture} onClick={() => void run(() => next(false))}><SkipForward size={16} />다음 조명</Button>
      <Button disabled={readOnly || pending || !fixture} onClick={() => void run(() => next(true))}>건너뛰기</Button>
    </div>
  </section>;
}
