import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, KeyRound, LockKeyhole } from "lucide-react";
import { completeMfaLogin, getCurrentUser, login, type AuthUser, type MfaLoginChallenge } from "../../api/auth";
import { classifyApiFailure, isTransientApiError } from "../../api/client";
import { KindaLogo } from "../../components/brand/KindaLogo";
import {
  Button,
  Card,
  Checkbox,
  FeedbackState,
  Heading,
  PasswordField,
  Text,
  TextField
} from "../../components/ui";

interface AuthViewProps {
  onAuthenticated: (auth: { user: AuthUser }) => Promise<void>;
}

export function AuthView({ onAuthenticated }: AuthViewProps) {
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [challenge, setChallenge] = useState<MfaLoginChallenge | null>(null);
  const [verificationMode, setVerificationMode] = useState<"totp" | "recovery">("totp");
  const [verificationValue, setVerificationValue] = useState("");
  const requestInFlight = useRef(false);
  const verificationInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (challenge) verificationInputRef.current?.focus();
  }, [challenge, verificationMode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestInFlight.current) return;
    setErrorMessage("");
    requestInFlight.current = true;
    setIsPending(true);
    try {
      const auth = await login({ loginId, password, rememberMe });
      setPassword("");
      if ("mfaRequired" in auth) {
        setChallenge(auth);
        setVerificationMode("totp");
        setVerificationValue("");
        return;
      }
      await onAuthenticated(auth);
    } catch (error) {
      if (isTransientApiError(error) && await recoverAuthenticatedSession(onAuthenticated)) {
        setPassword("");
        return;
      }
      setErrorMessage(loginErrorMessage(error));
    } finally {
      requestInFlight.current = false;
      setIsPending(false);
    }
  }

  async function submitMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge || requestInFlight.current || !verificationValue.trim()) return;
    requestInFlight.current = true;
    setIsPending(true);
    setErrorMessage("");
    try {
      const auth = await completeMfaLogin({
        challengeToken: challenge.challengeToken,
        ...(verificationMode === "totp"
          ? { code: verificationValue.trim() }
          : { recoveryCode: verificationValue.trim() })
      });
      setVerificationValue("");
      await onAuthenticated({ user: auth.user });
    } catch (error) {
      setVerificationValue("");
      if (isTransientApiError(error)) {
        if (await recoverAuthenticatedSession(onAuthenticated)) return;
        setChallenge(null);
        setErrorMessage(mfaErrorMessage(error, true));
      } else {
        if (errorStatus(error) === 401) setChallenge(null);
        setErrorMessage(mfaErrorMessage(error, false));
      }
    } finally {
      requestInFlight.current = false;
      setIsPending(false);
    }
  }

  function returnToCredentials() {
    if (requestInFlight.current) return;
    setChallenge(null);
    setVerificationValue("");
    setErrorMessage("");
  }

  const authStage = challenge ? verificationMode : "credentials";
  const authStatus = isPending ? "pending" : errorMessage ? "error" : "ready";

  return (
    <main className="mx-auto grid min-h-screen w-full max-w-auth grid-cols-2 items-center gap-12 bg-surface-canvas px-6 py-10 max-compact:grid-cols-1 max-compact:content-center max-compact:gap-7 max-compact:px-4 max-compact:py-8">
      <section className="max-w-xl" aria-label="킨다 소개">
        <KindaLogo className="mb-7" />
        <Heading as="h1" variant="display">빛을 더 안정적으로,<br />현장을 더 선명하게.</Heading>
        <Text className="mt-5 max-w-lg" variant="body-lg" tone="secondary">주차장 LED 조명의 상태, 제어, 에너지 사용량을 하나의 차분한 운영 화면에서 확인하세요.</Text>
      </section>
      <Card
        data-testid="auth-stage-card"
        data-auth-stage={authStage}
        data-auth-status={authStatus}
        className="grid w-full max-w-lg gap-5 p-6 shadow-panel"
      >
        {challenge ? (
          <>
            <div className="grid gap-1.5">
              <Text as="span" variant="overline" tone="secondary">계정 보안</Text>
              <Heading>2단계 인증</Heading>
              <Text variant="body-sm" tone="secondary">인증 앱의 6자리 코드 또는 저장한 복구 코드를 입력하세요.</Text>
            </div>
            <form className="grid gap-3.5" onSubmit={submitMfa}>
              <TextField
                ref={verificationInputRef}
                label={verificationMode === "totp" ? "인증 앱 코드" : "복구 코드"}
                inputMode={verificationMode === "totp" ? "numeric" : "text"}
                autoComplete="one-time-code"
                value={verificationValue}
                onChange={setVerificationValue}
                maxLength={verificationMode === "totp" ? 6 : 128}
                isRequired
              />
              <Button type="submit" variant="primary" isLoading={isPending} loadingLabel="인증 중" data-auth-submit>
                <KeyRound size={18} aria-hidden="true" />
                인증하고 로그인
              </Button>
              <Button type="button" variant="ghost" onClick={() => {
                setVerificationMode((mode) => mode === "totp" ? "recovery" : "totp");
                setVerificationValue("");
                setErrorMessage("");
              }} disabled={isPending}>
                {verificationMode === "totp" ? "복구 코드 사용" : "인증 앱 코드 사용"}
              </Button>
              <Button type="button" variant="ghost" onClick={returnToCredentials} disabled={isPending}>
                <ArrowLeft size={18} aria-hidden="true" />
                아이디와 비밀번호 다시 입력
              </Button>
            </form>
          </>
        ) : (
          <>
            <div className="grid gap-1.5">
              <Text as="span" variant="overline" tone="secondary">계정 로그인</Text>
              <Heading>킨다 로그인</Heading>
            </div>
            <form className="grid gap-3.5" onSubmit={submit}>
            <TextField
              label="아이디"
              value={loginId}
              onChange={setLoginId}
              autoComplete="username"
              isRequired
            />
            <PasswordField
              label="비밀번호"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              isRequired
            />
            <Checkbox
              label="자동 로그인"
              isSelected={rememberMe}
              onChange={setRememberMe}
            />
            <Button className="mt-1" type="submit" variant="primary" isLoading={isPending} loadingLabel="로그인 중" data-auth-submit>
              <LockKeyhole size={18} aria-hidden="true" />
              로그인
            </Button>
            </form>
          </>
        )}

        {errorMessage ? <FeedbackState className="mt-3.5" tone="danger" icon={CircleAlert} title={errorMessage} /> : null}
        <Text variant="caption" tone="secondary">로그인에 문제가 계속되면 서비스 운영 담당자에게 문의하세요.</Text>
      </Card>
    </main>
  );
}

function loginErrorMessage(error: unknown) {
  switch (classifyApiFailure(error)) {
    case "unauthorized":
      return "아이디 또는 비밀번호를 확인해 주세요.";
    case "forbidden":
      return "이 계정으로 로그인할 수 없습니다. 관리자에게 문의해 주세요.";
    case "rate_limited":
      return "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.";
    case "server":
      return "인증 서비스에 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.";
    case "transport":
      return "서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.";
    case "timeout":
      return "로그인 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.";
    default:
      return "로그인 요청을 처리하지 못했습니다. 입력 내용을 확인해 주세요.";
  }
}

function mfaErrorMessage(error: unknown, requiresNewCredentials: boolean) {
  const suffix = requiresNewCredentials ? " 아이디와 비밀번호부터 다시 입력해 주세요." : "";
  switch (classifyApiFailure(error)) {
    case "unauthorized":
      return "인증 코드가 올바르지 않거나 만료되었습니다. 아이디와 비밀번호부터 다시 입력해 주세요.";
    case "forbidden":
      return "이 계정으로 인증을 완료할 수 없습니다. 관리자에게 문의해 주세요.";
    case "rate_limited":
      return "인증 시도가 너무 많습니다. 잠시 후 다시 로그인해 주세요.";
    case "server":
      return `인증 서비스에 문제가 발생했습니다.${suffix || " 잠시 후 다시 시도해 주세요."}`;
    case "transport":
      return `서버에 연결하지 못했습니다.${suffix || " 네트워크를 확인한 뒤 다시 시도해 주세요."}`;
    case "timeout":
      return `인증 응답이 지연되고 있습니다.${suffix || " 잠시 후 다시 시도해 주세요."}`;
    default:
      return "2단계 인증 요청을 처리하지 못했습니다. 다시 시도해 주세요.";
  }
}

async function recoverAuthenticatedSession(onAuthenticated: AuthViewProps["onAuthenticated"]) {
  try {
    await onAuthenticated(await getCurrentUser());
    return true;
  } catch {
    return false;
  }
}

function errorStatus(error: unknown) {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : null;
}
