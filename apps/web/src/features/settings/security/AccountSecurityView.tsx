import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Laptop, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  confirmMfaEnrollment,
  disableMfa,
  getMfaStatus,
  listAuthSessions,
  revokeAuthSession,
  revokeOtherAuthSessions,
  startMfaEnrollment,
  type AuthSession,
  type AuthUser,
  type MfaEnrollment
} from "../../../api/auth";
import { authSessionsQueryKey, clearPrincipalCache, hasPrincipal, principalKey } from "../../../api/principal-cache";
import { Button, Card, ConfirmDialog, FeedbackState, PageHeader, PasswordField, StatusBadge, TextField } from "../../../components/ui";
import { PasswordChangeCard } from "./PasswordSettingsView";

type MfaQueryKey = readonly ["auth", "mfa", string];
type SessionsQueryKey = ReturnType<typeof authSessionsQueryKey>;

export function AccountSecurityView({ user }: { user: AuthUser }) {
  const principal = principalKey(user);
  const mfaQueryKey: MfaQueryKey = ["auth", "mfa", principal];
  const sessionsQueryKey = authSessionsQueryKey(principal);

  return (
    <section className="grid gap-5">
      <PageHeader title="계정 보안" description="비밀번호, 2단계 인증과 로그인된 기기를 관리합니다." />
      <div key={principal} className="grid gap-5">
        <PasswordChangeCard />
        {user.role === "admin" || user.role === "operator" ? (
          <MfaCard principal={principal} mfaQueryKey={mfaQueryKey} sessionsQueryKey={sessionsQueryKey} />
        ) : null}
        <SessionsCard principal={principal} sessionsQueryKey={sessionsQueryKey} />
      </div>
    </section>
  );
}

function MfaCard({
  principal,
  mfaQueryKey,
  sessionsQueryKey
}: {
  principal: string;
  mfaQueryKey: MfaQueryKey;
  sessionsQueryKey: SessionsQueryKey;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: mfaQueryKey,
    queryFn: getMfaStatus,
    retry: false
  });
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [disableValue, setDisableValue] = useState("");
  const [disableMode, setDisableMode] = useState<"totp" | "recovery">("totp");
  const [showDisable, setShowDisable] = useState(false);
  const [pendingAction, setPendingAction] = useState<"start" | "confirm" | "disable" | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, [principal]);

  const isCurrentPrincipal = () => mounted.current && hasPrincipal(queryClient, principal);

  async function startEnrollment() {
    if (pendingAction) return;
    setPendingAction("start");
    setMessage(null);
    try {
      const result = await startMfaEnrollment();
      if (!isCurrentPrincipal()) return;
      setEnrollment(result);
      setCode("");
    } catch (requestError) {
      if (isCurrentPrincipal()) setMessage({ tone: "danger", text: securityErrorMessage(requestError, "2단계 인증 설정을 시작하지 못했습니다.") });
    } finally {
      if (isCurrentPrincipal()) setPendingAction(null);
    }
  }

  async function confirmEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrollment || pendingAction || !code.trim()) return;
    setPendingAction("confirm");
    setMessage(null);
    try {
      const result = await confirmMfaEnrollment({ enrollmentToken: enrollment.enrollmentToken, code: code.trim() });
      if (!isCurrentPrincipal()) return;
      setEnrollment(null);
      setCode("");
      setRecoveryCodes(result.recoveryCodes);
      queryClient.setQueryData(mfaQueryKey, { enabled: true, enabledAt: new Date().toISOString() });
      void queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
    } catch (requestError) {
      if (isCurrentPrincipal()) {
        if (errorStatus(requestError) === 401) setEnrollment(null);
        setMessage({ tone: "danger", text: errorStatus(requestError) === 401
          ? "인증 코드가 올바르지 않거나 등록 시간이 만료되었습니다. 설정을 다시 시작해 주세요."
          : securityErrorMessage(requestError, "인증 앱 코드를 확인하지 못했습니다.") });
      }
    } finally {
      if (isCurrentPrincipal()) setPendingAction(null);
    }
  }

  async function submitDisable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingAction || !currentPassword || !disableValue.trim()) return;
    setPendingAction("disable");
    setMessage(null);
    try {
      await disableMfa({
        currentPassword,
        ...(disableMode === "totp" ? { code: disableValue.trim() } : { recoveryCode: disableValue.trim() })
      });
      if (!isCurrentPrincipal()) return;
      setCurrentPassword("");
      setDisableValue("");
      setShowDisable(false);
      queryClient.setQueryData(mfaQueryKey, { enabled: false, enabledAt: null });
      void queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
      setMessage({ tone: "success", text: "2단계 인증을 해제했습니다." });
    } catch (requestError) {
      if (isCurrentPrincipal()) setMessage({ tone: "danger", text: securityErrorMessage(requestError, "2단계 인증을 해제하지 못했습니다.") });
    } finally {
      if (isCurrentPrincipal()) setPendingAction(null);
    }
  }

  return (
    <Card className="grid gap-5 p-5" aria-labelledby="mfa-card-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="mfa-card-title" className="m-0 text-card-title font-bold">2단계 인증</h2>
          <p className="mt-1 text-content-secondary">인증 앱 코드로 operator와 admin 계정을 추가 보호합니다.</p>
        </div>
        <ShieldCheck size={22} aria-hidden="true" />
      </div>
      {isLoading ? <FeedbackState tone="neutral" icon={RefreshCw} title="2단계 인증 상태를 확인하는 중입니다." /> : null}
      {error ? (
        <FeedbackState
          tone="danger"
          icon={CircleAlert}
          title="2단계 인증 상태를 불러오지 못했습니다."
          action={<Button type="button" variant="secondary" onClick={() => void refetch()}>다시 시도</Button>}
        />
      ) : null}
      {data && !enrollment && recoveryCodes.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <strong>{data.enabled ? "2단계 인증이 켜져 있습니다." : "2단계 인증이 꺼져 있습니다."}</strong>
            <p>{data.enabled ? "로그인할 때 인증 앱 또는 복구 코드가 필요합니다." : "계정 탈취 위험을 줄이려면 설정을 권장합니다."}</p>
          </div>
          {data.enabled ? (
            <Button type="button" variant="danger" onClick={() => setShowDisable((value) => !value)}>2단계 인증 해제</Button>
          ) : (
            <Button type="button" variant="primary" isLoading={pendingAction === "start"} loadingLabel="준비 중" onClick={() => void startEnrollment()}>2단계 인증 설정</Button>
          )}
        </div>
      ) : null}
      {enrollment ? (
        <form className="grid gap-4" aria-label="2단계 인증 설정" onSubmit={confirmEnrollment}>
          <p>인증 앱에서 아래 설정 키를 직접 입력한 뒤 생성된 6자리 코드를 확인하세요.</p>
          <code className="break-all rounded-control bg-surface-inset p-3" aria-label="인증 앱 설정 키">{enrollment.secret}</code>
          <TextField label="인증 앱 코드" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={setCode} isRequired />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" isLoading={pendingAction === "confirm"} loadingLabel="확인 중">설정 완료</Button>
            <Button type="button" variant="ghost" disabled={Boolean(pendingAction)} onClick={() => { setEnrollment(null); setCode(""); }}>취소</Button>
          </div>
        </form>
      ) : null}
      {recoveryCodes.length > 0 ? (
        <div className="grid gap-3 rounded-panel border border-status-warning-border bg-status-warning-background p-4" role="status" aria-live="polite">
          <strong>복구 코드는 지금 한 번만 표시됩니다.</strong>
          <p>인증 앱을 사용할 수 없을 때 각 코드를 한 번씩 사용할 수 있습니다.</p>
          <ul aria-label="복구 코드">{recoveryCodes.map((recoveryCode) => <li key={recoveryCode}><code>{recoveryCode}</code></li>)}</ul>
          <Button type="button" variant="primary" onClick={() => setRecoveryCodes([])}>복구 코드를 안전하게 보관했습니다</Button>
        </div>
      ) : null}
      {data?.enabled && showDisable ? (
        <form className="grid gap-4" aria-label="2단계 인증 해제" onSubmit={submitDisable}>
          <PasswordField label="MFA 해제용 현재 비밀번호" autoComplete="current-password" value={currentPassword} onChange={setCurrentPassword} isRequired />
          <TextField label={disableMode === "totp" ? "MFA 해제용 인증 앱 코드" : "MFA 해제용 복구 코드"} inputMode={disableMode === "totp" ? "numeric" : "text"} autoComplete="one-time-code" value={disableValue} onChange={setDisableValue} isRequired />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" isLoading={pendingAction === "disable"} loadingLabel="해제 중">해제 확인</Button>
            <Button type="button" variant="ghost" disabled={Boolean(pendingAction)} onClick={() => { setDisableMode((mode) => mode === "totp" ? "recovery" : "totp"); setDisableValue(""); }}>
              {disableMode === "totp" ? "복구 코드 사용" : "인증 앱 코드 사용"}
            </Button>
          </div>
        </form>
      ) : null}
      {message ? <FeedbackState tone={message.tone} icon={message.tone === "success" ? CircleCheck : CircleAlert} title={message.text} /> : null}
    </Card>
  );
}

function SessionsCard({ principal, sessionsQueryKey }: { principal: string; sessionsQueryKey: SessionsQueryKey }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: sessionsQueryKey,
    queryFn: listAuthSessions,
    retry: false
  });
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [sessionToConfirm, setSessionToConfirm] = useState<AuthSession | null>(null);
  const [isRevokingOthers, setIsRevokingOthers] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, [principal]);

  const isCurrentPrincipal = () => mounted.current && hasPrincipal(queryClient, principal);

  async function revokeSession(session: AuthSession) {
    if (pendingSessionId || isRevokingOthers) return;
    if (session.current) {
      setSessionToConfirm(session);
      return;
    }
    await revokeSessionNow(session);
  }

  async function revokeSessionNow(session: AuthSession) {
    setPendingSessionId(session.id);
    setMessage(null);
    try {
      await revokeAuthSession(session.id);
      if (!isCurrentPrincipal()) return;
      if (session.current) {
        await clearPrincipalCache(queryClient, {
          expectedPrincipalKey: principal,
          isOperationCurrent: () => mounted.current
        });
        return;
      }
      queryClient.setQueryData<{ sessions: AuthSession[] }>(sessionsQueryKey, (current) => ({
        sessions: current?.sessions.filter((candidate) => candidate.id !== session.id) ?? []
      }));
      setMessage({ tone: "success", text: "선택한 세션을 종료했습니다." });
    } catch (requestError) {
      if (isCurrentPrincipal()) setMessage({ tone: "danger", text: securityErrorMessage(requestError, "세션을 종료하지 못했습니다.") });
    } finally {
      if (isCurrentPrincipal()) setPendingSessionId(null);
    }
  }

  async function revokeOthers() {
    if (pendingSessionId || isRevokingOthers) return;
    setIsRevokingOthers(true);
    setMessage(null);
    try {
      const result = await revokeOtherAuthSessions();
      if (!isCurrentPrincipal()) return;
      queryClient.setQueryData<{ sessions: AuthSession[] }>(sessionsQueryKey, (current) => ({
        sessions: current?.sessions.filter((session) => session.current) ?? []
      }));
      setMessage({ tone: "success", text: `다른 세션 ${result.revokedSessionCount}개를 종료했습니다.` });
    } catch (requestError) {
      if (isCurrentPrincipal()) setMessage({ tone: "danger", text: securityErrorMessage(requestError, "다른 세션을 종료하지 못했습니다.") });
    } finally {
      if (isCurrentPrincipal()) setIsRevokingOthers(false);
    }
  }

  const sessions = data?.sessions ?? [];
  const otherSessionCount = sessions.filter((session) => !session.current).length;

  return (
    <Card className="grid gap-5 p-5" aria-labelledby="sessions-card-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="sessions-card-title" className="m-0 text-card-title font-bold">활성 세션</h2>
          <p className="mt-1 text-content-secondary">현재 로그인된 브라우저와 기기를 확인하고 필요 없는 세션을 종료합니다.</p>
        </div>
        <Laptop size={22} aria-hidden="true" />
      </div>
      {isLoading ? <FeedbackState tone="neutral" icon={RefreshCw} title="활성 세션을 불러오는 중입니다." /> : null}
      {error ? (
        <FeedbackState
          tone="danger"
          icon={CircleAlert}
          title="활성 세션을 불러오지 못했습니다."
          action={<Button type="button" variant="secondary" onClick={() => void refetch()}>다시 시도</Button>}
        />
      ) : null}
      {data && sessions.length === 0 ? <FeedbackState tone="neutral" icon={Laptop} title="표시할 활성 세션이 없습니다." /> : null}
      {sessions.length > 0 ? (
        <>
          <ul className="grid list-none gap-3 p-0" aria-label="활성 세션">
            {sessions.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center justify-between gap-4 rounded-control border border-border-default p-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{session.userAgent || "알 수 없는 브라우저"}</strong>
                    {session.current ? <StatusBadge tone="success" icon={CircleCheck}>현재 세션</StatusBadge> : null}
                  </div>
                  <p>{session.ipAddress || "IP 정보 없음"} · {session.rememberMe ? "자동 로그인" : "일반 로그인"} · {session.mfaVerified ? "MFA 확인" : "비밀번호 확인"}</p>
                  <p>로그인 {formatDateTime(session.createdAt)} · 만료 {formatDateTime(session.expiresAt)}</p>
                </div>
                <Button
                  type="button"
                  variant={session.current ? "danger" : "secondary"}
                  isLoading={pendingSessionId === session.id}
                  loadingLabel="종료 중"
                  disabled={Boolean(pendingSessionId) || isRevokingOthers}
                  onClick={() => void revokeSession(session)}
                >
                  {session.current ? "현재 세션 종료" : "이 세션 종료"}
                </Button>
              </li>
            ))}
          </ul>
          <Button type="button" variant="secondary" disabled={otherSessionCount === 0 || Boolean(pendingSessionId)} isLoading={isRevokingOthers} loadingLabel="종료 중" onClick={() => void revokeOthers()}>
            다른 세션 모두 종료
          </Button>
        </>
      ) : null}
      {message ? <FeedbackState tone={message.tone} icon={message.tone === "success" ? CircleCheck : CircleAlert} title={message.text} /> : null}
      <ConfirmDialog
        isOpen={sessionToConfirm !== null}
        title="현재 세션 종료"
        role="alertdialog"
        confirmLabel="세션 종료"
        tone="danger"
        onCancel={() => setSessionToConfirm(null)}
        onConfirm={() => {
          if (!sessionToConfirm) return;
          const session = sessionToConfirm;
          setSessionToConfirm(null);
          void revokeSessionNow(session);
        }}
      >
        현재 세션을 종료하면 로그인 화면으로 이동합니다. 계속하시겠습니까?
      </ConfirmDialog>
    </Card>
  );
}

function securityErrorMessage(error: unknown, fallback: string) {
  const status = errorStatus(error);
  if (status === 401) return "인증 정보가 올바르지 않거나 로그인 세션이 만료되었습니다.";
  if (status === 429) return "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  if (status === 503) return "계정 보안 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  return fallback;
}

function errorStatus(error: unknown) {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : null;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시각 정보 없음";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
