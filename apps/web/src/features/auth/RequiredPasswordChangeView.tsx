import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, KeyRound, LogOut } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { changePassword, logout, type AuthUser } from "../../api/auth";
import { authMeQueryKey, clearTenantCache, hasPrincipal, principalKey, replacePrincipalCache } from "../../api/principal-cache";
import { Button, Card, FeedbackState } from "../../components/ui";
import { blockActiveCommandSession, unblockActiveCommandSession } from "../control/active-command-session";
import { clearActiveCommandsForUser } from "../control/active-command-store";
import { passwordChangeErrorMessage, validatePasswordChange } from "./password-form";
import "./RequiredPasswordChangeView.css";

interface PasswordOperation {
  id: number;
  lifecycle: number;
  principal: string;
  kind: "change" | "logout";
}

export function RequiredPasswordChangeView({ user, onCompleted }: {
  user: AuthUser;
  onCompleted: () => void;
}) {
  const queryClient = useQueryClient();
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<PasswordOperation | null>(null);
  const operationGenerationRef = useRef(0);
  const lifecycleGenerationRef = useRef(0);
  const scopedPrincipal = principalKey(user);
  const principalRef = useRef(scopedPrincipal);
  principalRef.current = scopedPrincipal;
  const mountedRef = useRef(false);
  const committedRef = useRef(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [action, setAction] = useState<"change" | "logout" | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    committedRef.current = false;
    const lifecycle = ++lifecycleGenerationRef.current;
    return () => {
      if (lifecycleGenerationRef.current === lifecycle) {
        mountedRef.current = false;
        lifecycleGenerationRef.current += 1;
        actionRef.current = null;
      }
      if (!committedRef.current) unblockActiveCommandSession(user.id);
    };
  }, [scopedPrincipal, user.id]);

  function beginOperation(kind: PasswordOperation["kind"]) {
    if (actionRef.current || !mountedRef.current) return null;
    const operation = {
      id: ++operationGenerationRef.current,
      lifecycle: lifecycleGenerationRef.current,
      principal: scopedPrincipal,
      kind,
    };
    actionRef.current = operation;
    return operation;
  }

  function isCurrentOperation(operation: PasswordOperation) {
    return mountedRef.current
      && actionRef.current === operation
      && lifecycleGenerationRef.current === operation.lifecycle
      && principalRef.current === operation.principal;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionRef.current) return;
    const validationMessage = validatePasswordChange(currentPassword, newPassword, confirmation, "현재 임시 비밀번호");
    if (validationMessage) {
      setErrorMessage(validationMessage);
      return;
    }

    const operation = beginOperation("change");
    if (!operation) return;
    setAction("change");
    setErrorMessage("");
    blockActiveCommandSession(user.id);
    try {
      const result = await changePassword({ currentPassword, newPassword, newPasswordConfirmation: confirmation });
      const applied = await replacePrincipalCache(queryClient, { user: result.user }, {
        expectedPrincipalKey: operation.principal,
        isOperationCurrent: () => isCurrentOperation(operation),
      });
      if (!applied || !isCurrentOperation(operation)) return;
      clearActiveCommandsForUser(user.id);
      committedRef.current = true;
      onCompleted();
    } catch (error) {
      if (!isCurrentOperation(operation)) return;
      unblockActiveCommandSession(user.id);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setErrorMessage(passwordChangeErrorMessage(error, "비밀번호를 변경하지 못했습니다. 다시 시도해 주세요."));
      currentPasswordRef.current?.focus();
    } finally {
      if (isCurrentOperation(operation)) {
        actionRef.current = null;
        setAction(null);
      }
    }
  }

  async function handleLogout() {
    if (actionRef.current) return;
    const operation = beginOperation("logout");
    if (!operation) return;
    setAction("logout");
    setErrorMessage("");
    blockActiveCommandSession(user.id);
    try {
      await logout();
      if (!isCurrentOperation(operation) || !hasPrincipal(queryClient, operation.principal)) return;
      clearActiveCommandsForUser(user.id);
      clearTenantCache(queryClient);
      committedRef.current = true;
      queryClient.setQueryData(authMeQueryKey, null);
    } catch {
      if (!isCurrentOperation(operation)) return;
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
