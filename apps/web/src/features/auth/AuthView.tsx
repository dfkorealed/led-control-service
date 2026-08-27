import { FormEvent, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { login, type AuthUser } from "../../api/auth";

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
      <section className="auth-panel">
        <div className="brand auth-brand">
          <span className="brand-mark">LC</span>
          <div>
            <strong>LED Control</strong>
            <span>관제 센터</span>
          </div>
        </div>

        <div className="auth-heading">
          <span className="eyebrow">계정 로그인</span>
          <h1>LED Control 로그인</h1>
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
          <button className="primary-button auth-submit" disabled={isPending}>
            <LockKeyhole size={18} />
            로그인
          </button>
        </form>

        {errorMessage && <p className="danger-text" role="alert">{errorMessage}</p>}
      </section>
    </main>
  );
}
