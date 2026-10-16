import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FixtureRegistrationRemovalPreview, FixtureRegistrationRemovalView } from "@led-control/shared/fixture-registration-removal-contracts";
import { CircleAlert } from "lucide-react";
import {
  findFixtureRegistrationRemovalByRequest, getFixtureRegistrationRemoval,
  getFixtureRegistrationRemovalPreview, requestFixtureRegistrationRemoval
} from "../../../api/fixture-registration-removals";
import { ApiError } from "../../../api/client";
import type { FixtureSettingsItem } from "../../../api/site-settings";
import { Button, FeedbackState, LoadingState, useSessionToast } from "../../../components/ui";
import { DeleteFixtureRegistrationDialog } from "./DeleteFixtureRegistrationDialog";
import { forgetFixtureRemoval, loadFixtureRemovals, saveFixtureRemoval, type StoredFixtureRemoval } from "./fixture-registration-removal-storage";

export interface FixtureRemovalTarget { siteId: string; floorId: string; fixture: FixtureSettingsItem; trigger: HTMLElement | null }
interface Entry { record: StoredFixtureRemoval; view?: FixtureRegistrationRemovalView; checking?: boolean; unknown?: boolean; error?: string }
const statusLabels = {
  pending: "삭제 접수 · Gateway 확인 대기", gateway_confirmed: "Gateway 정리 확인 · 서버 반영 중",
  completed: "등록 삭제 완료", rejected: "등록 삭제 거절", reconcile_required: "결과 재조정 필요"
} as const;

// This component is keyed by principal/site by its owner. Every asynchronous
// continuation also checks its lifetime, including after query invalidation.
export function FixtureRegistrationRemovalFlow({ siteId, principal, target, onClose }: {
  siteId: string; principal: string; target: FixtureRemovalTarget | null; onClose(): void;
}) {
  const queryClient = useQueryClient();
  const toast = useSessionToast();
  const lifetime = useRef(true);
  const entriesRef = useRef<Entry[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [storageError, setStorageError] = useState("");
  const [preview, setPreview] = useState<FixtureRegistrationRemovalPreview>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [dialogError, setDialogError] = useState("");
  const [reconfirmationNotice, setReconfirmationNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const previewGeneration = useRef(0);
  const posting = useRef(new Set<string>());
  const checking = useRef(new Set<string>());
  const completed = useRef(new Set<string>());
  const currentTarget = useRef(target);
  const confirmation = useRef<object | null>(null);
  const confirmationAbort = useRef<AbortController | null>(null);
  currentTarget.current = target;

  function updateEntry(record: StoredFixtureRemoval, patch: Partial<Entry>) {
    if (!lifetime.current) return;
    const existing = entriesRef.current.find(entry => entry.record.clientRequestId === record.clientRequestId);
    const next = { ...existing, record, ...patch };
    entriesRef.current = [...entriesRef.current.filter(entry => entry.record.clientRequestId !== record.clientRequestId), next];
    setEntries(entriesRef.current);
  }

  async function adopt(record: StoredFixtureRemoval, view: FixtureRegistrationRemovalView) {
    if (!lifetime.current) return;
    const next = { ...record, operationId: view.operationId };
    // The original pre-POST record remains enough for by-request recovery if
    // an operation-id write fails. Storage is never evidence of completion.
    try { saveFixtureRemoval(next); } catch { /* Preserve the existing durable request identity. */ }
    updateEntry(next, { view, unknown: false, error: "", checking: false });
    if (view.status !== "completed" || completed.current.has(view.operationId)) return;
    completed.current.add(view.operationId);
    await Promise.all([
      ...["site-settings", "dashboard", "floor-fixtures", "floor-fixture-settings", "fixture-groups", "floor-map", "floor-editor"]
        .map(key => queryClient.invalidateQueries({ queryKey: [key, siteId] })),
      // No-query entry resolves its site from the response, not the key. Only
      // refresh matching default projections; another site's cache stays fresh.
      queryClient.invalidateQueries({ predicate: query => query.queryKey[0] === "dashboard" && query.queryKey[1] === "default"
        && (query.state.data as { site?: { id?: string } } | undefined)?.site?.id === siteId }),
      queryClient.invalidateQueries({ queryKey: ["registration-sessions", "active", siteId] }),
      queryClient.invalidateQueries({ predicate: query => query.queryKey[0] === "registration-session"
        && (query.state.data as { siteId?: string } | undefined)?.siteId === siteId })
    ]);
    if (!lifetime.current) return;
    toast.publish({ dedupeKey: `fixture-removal:${view.operationId}`, tone: "success", title: "조명 등록을 삭제했습니다.", description: record.fixtureName });
    try { forgetFixtureRemoval(next); } catch { /* Reopening checks the server again; never infer success from this record. */ }
    entriesRef.current = entriesRef.current.filter(entry => entry.record.clientRequestId !== record.clientRequestId);
    setEntries(entriesRef.current);
  }

  async function check(record: StoredFixtureRemoval) {
    if (!lifetime.current || checking.current.has(record.clientRequestId) || posting.current.has(record.clientRequestId)) return;
    checking.current.add(record.clientRequestId);
    updateEntry(record, { checking: true });
    try {
      const view = record.operationId
        ? await getFixtureRegistrationRemoval(record, record.operationId, { timeoutMs: 10_000 })
        : await findFixtureRegistrationRemovalByRequest(record, record.clientRequestId, { timeoutMs: 10_000 });
      if (!lifetime.current) return;
      if (view) await adopt(record, view);
      else updateEntry(record, { checking: false, unknown: true });
    } catch {
      updateEntry(record, { checking: false, unknown: true });
    } finally { checking.current.delete(record.clientRequestId); }
  }

  async function post(record: StoredFixtureRemoval) {
    if (!lifetime.current || posting.current.has(record.clientRequestId) || checking.current.has(record.clientRequestId)) return;
    try { saveFixtureRemoval(record); } catch {
      updateEntry(record, { unknown: true, error: "복구 정보를 저장하지 못해 등록 삭제 요청을 보내지 않았습니다. 저장소 접근 상태를 확인하세요." });
      return;
    }
    posting.current.add(record.clientRequestId);
    setSubmitting(true);
    let recoverByRequest = false;
    try {
      const view = await requestFixtureRegistrationRemoval(record, {
        clientRequestId: record.clientRequestId, expectedUpdatedAt: record.expectedUpdatedAt
      }, { timeoutMs: 10_000 });
      await adopt(record, view);
    } catch (error) {
      // Even an HTTP failure after dispatch can follow a committed operation.
      // Keep its identity and use GET; only a human can replay this exact body.
      updateEntry(record, { unknown: true, error: error instanceof ApiError && error.status === 409
        ? "삭제 조건이 변경되었습니다. 상태를 확인하세요." : "" });
      recoverByRequest = true;
    } finally {
      posting.current.delete(record.clientRequestId);
      if (lifetime.current) {
        setSubmitting(false);
        if (recoverByRequest) void check(record);
      }
    }
  }

  useEffect(() => {
    lifetime.current = true;
    try {
      const stored = loadFixtureRemovals(principal, siteId);
      entriesRef.current = stored.map(record => ({ record, unknown: true }));
      setEntries(entriesRef.current);
      for (const record of stored) void check(record);
    } catch { setStorageError("복구 정보를 읽지 못해 등록 삭제를 시작할 수 없습니다. 저장소 접근 상태를 확인하세요."); }
    return () => { lifetime.current = false; previewGeneration.current++; };
    // A keyed owner creates a fresh lifetime for every principal/site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const generation = ++previewGeneration.current;
    confirmationAbort.current?.abort(); confirmationAbort.current = null; confirmation.current = null;
    setPreview(undefined); setDialogError(""); setReconfirmationNotice(""); setPreviewLoading(Boolean(target));
    if (!target) return;
    const controller = new AbortController();
    void getFixtureRegistrationRemovalPreview({ siteId, floorId: target.floorId, fixtureId: target.fixture.id }, { signal: controller.signal, timeoutMs: 10_000 })
      .then(value => { if (lifetime.current && generation === previewGeneration.current) setPreview(value); })
      .catch(() => { if (lifetime.current && generation === previewGeneration.current) setDialogError("삭제 가능 여부를 확인하지 못했습니다."); })
      .finally(() => { if (lifetime.current && generation === previewGeneration.current) setPreviewLoading(false); });
    return () => { controller.abort(); confirmationAbort.current?.abort(); };
  }, [target, siteId, previewRevision]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const entry of entriesRef.current) if (!entry.unknown && (entry.view?.status === "pending" || entry.view?.status === "gateway_confirmed")) void check(entry.record);
    }, 1500);
    return () => window.clearInterval(timer);
    // Reads the live operation list without restarting an in-flight request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm() {
    if (!target || target !== currentTarget.current || !preview?.allowed || preview.fixtureId !== target.fixture.id
      || previewLoading || submitting || storageError || confirmation.current) return;
    // A second click/reopen must never mint another request for this fixture.
    if (entriesRef.current.some(entry => entry.record.fixtureId === target.fixture.id && entry.record.floorId === target.floorId)) { onClose(); return; }
    const displayedPreview = preview;
    const capturedTarget = target;
    const generation = previewGeneration.current;
    const token = {};
    const controller = new AbortController();
    confirmation.current = token; confirmationAbort.current = controller;
    const isCurrent = () => lifetime.current && currentTarget.current === capturedTarget
      && previewGeneration.current === generation && confirmation.current === token;
    setPreviewLoading(true); setDialogError(""); setReconfirmationNotice("");
    try {
      const fresh = await getFixtureRegistrationRemovalPreview({ siteId, floorId: target.floorId, fixtureId: target.fixture.id },
        { signal: controller.signal, timeoutMs: 10_000 });
      if (!isCurrent()) return;
      setPreview(fresh);
      if (!fresh.allowed) return;
      if (fresh.fixtureName !== displayedPreview.fixtureName || fresh.serialNumber !== displayedPreview.serialNumber) {
        setReconfirmationNotice("조명 정보가 변경되었습니다. 변경된 이름과 시리얼을 확인한 뒤 다시 등록 삭제를 눌러 주세요.");
        return;
      }
      // Telemetry updates Fixture.updatedAt too. Pin the final preview's current
      // token only after identity confirmation; every later replay keeps it.
      const record: StoredFixtureRemoval = { principal, siteId, floorId: target.floorId, fixtureId: target.fixture.id,
        clientRequestId: crypto.randomUUID(), expectedUpdatedAt: fresh.expectedUpdatedAt,
        fixtureName: fresh.fixtureName, serialNumber: fresh.serialNumber };
      try { saveFixtureRemoval(record); } catch { setDialogError("복구 정보를 저장하지 못해 등록 삭제를 시작하지 않았습니다. 저장소 접근 상태를 확인하세요."); return; }
      updateEntry(record, {});
      onClose();
      void post(record);
    } catch {
      if (isCurrent()) setDialogError("최종 삭제 가능 여부를 확인하지 못했습니다. 다시 확인해 주세요.");
    } finally {
      const current = isCurrent();
      if (confirmation.current === token) { confirmation.current = null; confirmationAbort.current = null; }
      if (current) setPreviewLoading(false);
    }
  }

  function acknowledgeRejection(entry: Entry) {
    if (entry.unknown || entry.view?.status !== "rejected") return;
    try { forgetFixtureRemoval(entry.record); } catch {
      updateEntry(entry.record, { error: "거절 결과의 복구 기록을 정리하지 못했습니다. 저장소 접근 상태를 확인하세요." });
      return;
    }
    entriesRef.current = entriesRef.current.filter(value => value.record.clientRequestId !== entry.record.clientRequestId);
    setEntries(entriesRef.current);
    onClose();
  }

  const existing = target ? entries.find(entry => entry.record.fixtureId === target.fixture.id && entry.record.floorId === target.floorId) : undefined;
  return <>
    {storageError ? <FeedbackState tone="danger" icon={CircleAlert} title={storageError} /> : null}
    {entries.length ? <section aria-label="등록 삭제 작업" className="grid min-w-0 gap-4 border-t border-border-default pt-4">
      {entries.map(entry => <div key={entry.record.clientRequestId} className="grid min-w-0 gap-2" role="group" aria-label={`${entry.record.fixtureName} 등록 삭제 상태`}>
        <strong className="wrap-anywhere">{entry.record.fixtureName} · {entry.record.serialNumber ?? "시리얼 확인되지 않음"}</strong>
        <p className="m-0" role="status">{entry.unknown ? "요청 결과 미확인" : entry.view ? statusLabels[entry.view.status] : "등록 삭제 요청 중"}</p>
        {entry.view?.status === "reconcile_required" ? <p className="m-0">실행 결과를 확정하지 못했습니다. 새 삭제 요청 없이 같은 작업의 상태만 확인할 수 있습니다.</p> : null}
        {entry.view?.status === "rejected" ? <p className="m-0">등록 삭제가 거절되어 기존 등록이 유지됩니다. 차단 사유를 해결한 뒤 새로 확인하세요.</p> : null}
        {entry.error ? <p className="m-0" role="alert">{entry.error}</p> : null}
        {entry.view?.errorCode ? <p className="m-0 wrap-anywhere text-body-sm text-content-secondary">사유: {entry.view.errorCode}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button isLoading={entry.checking} loadingLabel="상태 확인 중" disabled={submitting} onClick={() => void check(entry.record)}>상태 확인</Button>
          {entry.unknown && !entry.record.operationId && !entry.view ? <Button disabled={entry.checking || submitting} onClick={() => void post(entry.record)}>같은 요청 다시 보내기</Button> : null}
          {!entry.unknown && entry.view?.status === "rejected" ? <Button disabled={entry.checking || submitting} onClick={() => acknowledgeRejection(entry)}>거절 결과 확인</Button> : null}
        </div>
        {entry.checking ? <LoadingState title="삭제 작업 상태를 확인하는 중입니다." /> : null}
      </div>)}
    </section> : null}
    {target && !existing ? <DeleteFixtureRegistrationDialog fixtureName={target.fixture.name} serialNumber={target.fixture.serialNumber}
      preview={preview} loading={previewLoading} pending={submitting} error={dialogError || storageError} trigger={target.trigger}
      notice={reconfirmationNotice}
      onRetryPreview={() => setPreviewRevision(value => value + 1)} onConfirm={confirm} onClose={onClose} /> : null}
  </>;
}
