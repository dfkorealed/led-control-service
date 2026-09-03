import { FormEvent, useState } from "react";
import { CircleAlert, LockKeyhole } from "lucide-react";
import { login, type AuthUser } from "../../api/auth";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { FeedbackState } from "../../components/ui/FeedbackState";

interface AuthViewProps {
  onAuthenticated: (auth: { user: AuthUser }) => Promise<void>;
}

export function AuthView({ onAuthenticated }: AuthViewProps) {
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [isPending, setIsPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) return;
    setErrorMessage("");
    setIsPending(true);
    try {
      const auth = await login({ loginId, password, rememberMe });
      await onAuthenticated(auth);
    } catch {
      setErrorMessage("아이디 또는 비밀번호를 확인해 주세요.");
      setIsPending(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-brand-panel" aria-label="LED Control 소개">
        <div className="brand auth-brand"><span className="brand-mark">LC</span><strong>LED Control</strong></div>
        <h1>빛을 더 안정적으로,<br />현장을 더 선명하게.</h1>
        <p>주차장 LED 조명의 상태, 제어, 에너지 사용량을 하나의 차분한 운영 화면에서 확인하세요.</p>
      </section>
      <Card className="auth-panel">
        <div className="auth-heading">
          <span className="eyebrow">계정 로그인</span>
          <h2>LED Control 로그인</h2>
        </div>

        <form className="auth-form" onSubmit={submit}>
          <label>
            아이디
            <input
              type="text"
              value={loginId}
              onChange={(event) => setLoginId(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            비밀번호
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
            />
            자동 로그인
          </label>
          <Button className="auth-submit" type="submit" variant="primary" isLoading={isPending} loadingLabel="로그인 중">
            <LockKeyhole size={18} aria-hidden="true" />
            로그인
          </Button>
        </form>

        {errorMessage ? <FeedbackState tone="danger" icon={CircleAlert} title={errorMessage} /> : null}
      </Card>
    </main>
  );
}
