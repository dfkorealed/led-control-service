import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, KeyRound, LockKeyhole } from "lucide-react";
import { completeMfaLogin, login, type AuthUser, type MfaLoginChallenge } from "../../api/auth";
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
      if (errorStatus(error) === 401) setChallenge(null);
      setErrorMessage(mfaErrorMessage(error));
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

  return (
    <main className="auth-shell mx-auto grid min-h-screen w-full max-w-6xl grid-cols-2 items-center gap-16 bg-surface-canvas p-6 max-compact:grid-cols-1 max-compact:content-center max-compact:gap-8 max-compact:px-4">
      <section className="auth-brand-panel max-w-xl" aria-label="킨다 소개">
        <KindaLogo className="auth-brand" />
        <Heading as="h1" variant="display">빛을 더 안정적으로,<br />현장을 더 선명하게.</Heading>
        <Text className="mt-5 max-w-lg" variant="body-lg" tone="secondary">주차장 LED 조명의 상태, 제어, 에너지 사용량을 하나의 차분한 운영 화면에서 확인하세요.</Text>
      </section>
      <Card className="auth-panel grid w-full max-w-lg gap-5 p-6 shadow-panel">
        {challenge ? (
          <>
            <div className="auth-heading grid gap-1.5">
              <Text as="span" variant="overline" tone="secondary">계정 보안</Text>
              <Heading>2단계 인증</Heading>
              <Text className="auth-helper" variant="body-sm" tone="secondary">인증 앱의 6자리 코드 또는 저장한 복구 코드를 입력하세요.</Text>
            </div>
            <form className="auth-form grid gap-3.5" onSubmit={submitMfa}>
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
              <Button className="auth-submit" type="submit" variant="primary" isLoading={isPending} loadingLabel="인증 중">
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
            <div className="auth-heading grid gap-1.5">
              <Text as="span" variant="overline" tone="secondary">계정 로그인</Text>
              <Heading>킨다 로그인</Heading>
            </div>
            <form className="auth-form grid gap-3.5" onSubmit={submit}>
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
              className="check-field"
              label="자동 로그인"
              isSelected={rememberMe}
              onChange={setRememberMe}
            />
            <Button className="auth-submit mt-1" type="submit" variant="primary" isLoading={isPending} loadingLabel="로그인 중">
              <LockKeyhole size={18} aria-hidden="true" />
              로그인
            </Button>
            </form>
          </>
        )}

        {errorMessage ? <FeedbackState className="mt-3.5" tone="danger" icon={CircleAlert} title={errorMessage} /> : null}
      </Card>
    </main>
  );
}

function loginErrorMessage(error: unknown) {
  if (errorStatus(error) === 429) {
    return "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (errorStatus(error) === 503) {
    return "인증 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  }
  return "아이디 또는 비밀번호를 확인해 주세요.";
}

function mfaErrorMessage(error: unknown) {
  if (errorStatus(error) === 429) {
    return "인증 시도가 너무 많습니다. 잠시 후 다시 로그인해 주세요.";
  }
  if (errorStatus(error) === 503) {
    return "인증 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (errorStatus(error) === 401) {
    return "인증 코드가 올바르지 않거나 만료되었습니다. 아이디와 비밀번호부터 다시 입력해 주세요.";
  }
  return "2단계 인증을 완료하지 못했습니다. 다시 시도해 주세요.";
}

function errorStatus(error: unknown) {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : null;
}
