import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import { LockKeyhole, UserPlus } from "lucide-react";
import { login, signup } from "../../api/auth";

interface AuthViewProps {
  onAuthenticated: () => void;
}

export function AuthView({ onAuthenticated }: AuthViewProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  const loginMutation = useMutation({
    mutationFn: login,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      onAuthenticated();
    },
    onError: () => setErrorMessage("아이디 또는 비밀번호를 확인해 주세요.")
  });

  const signupMutation = useMutation({
    mutationFn: signup,
    onSuccess: () => {
      setMode("login");
      setErrorMessage("가입이 완료되었습니다. 설정한 계정으로 로그인해 주세요.");
    },
    onError: () => setErrorMessage("초대 정보 또는 입력값을 확인해 주세요.")
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage("");
    if (mode === "login") {
      loginMutation.mutate({ loginId, password, rememberMe });
      return;
    }
    // The Task 6 UI still has one identifier field; the backend keeps its contact-email check separate.
    signupMutation.mutate({ token, loginId, email: loginId, name, password });
  }

  const isPending = loginMutation.isPending || signupMutation.isPending;

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
          <span className="eyebrow">{mode === "login" ? "계정 로그인" : "초대 기반 회원가입"}</span>
          <h1>{mode === "login" ? "LED Control 로그인" : "회원 가입"}</h1>
        </div>

        <form className="auth-form" onSubmit={submit}>
          {mode === "signup" && (
            <>
              <label>
                초대 코드
                <input value={token} onChange={(event) => setToken(event.target.value)} required />
              </label>
              <label>
                이름
                <input value={name} onChange={(event) => setName(event.target.value)} required />
              </label>
            </>
          )}
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
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
            />
          </label>
          {mode === "login" && (
            <label className="check-field">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(event) => setRememberMe(event.target.checked)}
              />
              자동 로그인
            </label>
          )}
          <button className="primary-button auth-submit" disabled={isPending}>
            {mode === "login" ? <LockKeyhole size={18} /> : <UserPlus size={18} />}
            {mode === "login" ? "로그인" : "가입하기"}
          </button>
        </form>

        {errorMessage && <p className={errorMessage.includes("완료") ? "success-text" : "danger-text"}>{errorMessage}</p>}

        <button className="link-button" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "초대 코드를 가지고 회원가입" : "이미 계정이 있으면 로그인"}
        </button>
      </section>
    </main>
  );
}
