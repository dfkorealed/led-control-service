import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, KeyRound, LogOut } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { changePassword, logout, type AuthUser } from "../../api/auth";
import { authMeQueryKey, clearTenantCache } from "../../api/principal-cache";
import { Button, Card, FeedbackState } from "../../components/ui";
import { blockActiveCommandSession, unblockActiveCommandSession } from "../control/active-command-session";
import { clearActiveCommandsForUser } from "../control/active-command-store";
import { passwordChangeErrorMessage, validatePasswordChange } from "./password-form";
import "./RequiredPasswordChangeView.css";

export function RequiredPasswordChangeView({ user, onAuthenticated }: {
  user: AuthUser;
  onAuthenticated: (auth: { user: AuthUser }) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<"change" | "logout" | null>(null);
  const mountedRef = useRef(true);
  const committedRef = useRef(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [action, setAction] = useState<"change" | "logout" | null>(null);

  useEffect(() => () => {
    mountedRef.current = false;
    if (!committedRef.current) unblockActiveCommandSession(user.id);
  }, [user.id]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionRef.current) return;
    const validationMessage = validatePasswordChange(currentPassword, newPassword, confirmation, "현재 임시 비밀번호");
    if (validationMessage) {
      setErrorMessage(validationMessage);
      return;
    }

    actionRef.current = "change";
    setAction("change");
    setErrorMessage("");
    blockActiveCommandSession(user.id);
    try {
      const result = await changePassword({ currentPassword, newPassword, newPasswordConfirmation: confirmation });
      if (!mountedRef.current) return;
      clearActiveCommandsForUser(user.id);
      committedRef.current = true;
      await onAuthenticated({ user: result.user });
    } catch (error) {
      if (!mountedRef.current) return;
      unblockActiveCommandSession(user.id);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setErrorMessage(passwordChangeErrorMessage(error, "비밀번호를 변경하지 못했습니다. 다시 시도해 주세요."));
      currentPasswordRef.current?.focus();
    } finally {
      if (mountedRef.current) {
        actionRef.current = null;
        setAction(null);
      }
    }
  }

  async function handleLogout() {
    if (actionRef.current) return;
    actionRef.current = "logout";
    setAction("logout");
    setErrorMessage("");
    blockActiveCommandSession(user.id);
    try {
      await logout();
      if (!mountedRef.current) return;
      clearActiveCommandsForUser(user.id);
      clearTenantCache(queryClient);
      committedRef.current = true;
      queryClient.setQueryData(authMeQueryKey, null);
    } catch {
      if (!mountedRef.current) return;
      unblockActiveCommandSession(user.id);
      actionRef.current = null;
      setAction(null);
      setErrorMessage("로그아웃에 실패했습니다. 연결을 확인한 뒤 다시 시도하세요.");
    }
  }

  return (
    <main className="required-password-shell">
      <Card className="required-password-card">
        <div className="required-password-heading">
          <span className="required-password-icon"><KeyRound size={22} aria-hidden="true" /></span>
          <div><span className="eyebrow">최초 로그인</span><h1>비밀번호를 변경해 주세요</h1></div>
        </div>
        <p>임시 비밀번호를 본인만 아는 비밀번호로 변경한 뒤 서비스를 이용할 수 있습니다.</p>
        <form aria-label="최초 로그인 비밀번호 변경" onSubmit={handleSubmit}>
          <label>현재 임시 비밀번호<input ref={currentPasswordRef} type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoFocus /></label>
          <label>새 비밀번호<input type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
          <label>새 비밀번호 확인<input type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
          {errorMessage ? <FeedbackState tone="danger" icon={CircleAlert} title={errorMessage} /> : null}
          <Button type="submit" variant="primary" isLoading={action === "change"} disabled={action !== null} loadingLabel="변경 중">비밀번호 변경</Button>
        </form>
        <Button type="button" variant="ghost" onClick={() => void handleLogout()} isLoading={action === "logout"} disabled={action !== null} loadingLabel="로그아웃 중"><LogOut size={16} aria-hidden="true" />로그아웃</Button>
      </Card>
    </main>
  );
}
