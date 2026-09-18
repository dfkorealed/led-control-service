import { useRef, useState, type FormEvent } from "react";
import { resetSiteUserPassword, type SiteUserSummary } from "../../../api/site-users";
import { Button, ModalDialog, PasswordField } from "../../../components/ui";
import { siteUserErrorMessage, validateTemporaryPassword } from "./site-user-form";

export function ResetSiteUserPasswordDialog({ siteId, user, returnFocusElement, fallbackFocusElement, onClose, onCompleted, onMutationError }: {
  siteId: string;
  user: SiteUserSummary;
  returnFocusElement?: HTMLElement | null;
  onClose: () => void;
  onCompleted: (message: string) => void;
  onMutationError?: (error: unknown) => Promise<string | null>;
  fallbackFocusElement?: HTMLElement | null;
}) {
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);
  const pendingRef = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pendingRef.current) return;
    const passwordError = validateTemporaryPassword(password);
    if (passwordError) return setError(passwordError);
    if (password !== confirmation) return setError("임시 비밀번호 확인이 일치하지 않습니다.");
    setError("");
    pendingRef.current = true;
    setIsPending(true);
    try {
      await resetSiteUserPassword(siteId, user.id, password);
      setPassword("");
      setConfirmation("");
      onClose();
      void onCompleted("비밀번호를 초기화했습니다. 사용자의 기존 세션이 종료되었습니다.");
    } catch (requestError) {
      const message = onMutationError ? await onMutationError(requestError) : siteUserErrorMessage(requestError);
      if (message) setError(message);
    } finally {
      pendingRef.current = false;
      setIsPending(false);
    }
  }

  return <ModalDialog
    title={`${user.name} 비밀번호 초기화`}
    description="새 임시 비밀번호를 지정합니다. 완료하면 모든 로그인 세션이 종료되고 다음 로그인에서 비밀번호 변경이 필요합니다."
    onClose={onClose}
    isPending={isPending}
    initialFocusRef={passwordRef}
    returnFocusElement={returnFocusElement}
    fallbackFocusElement={fallbackFocusElement}
    actions={<>
      <Button type="button" onClick={onClose} disabled={isPending}>취소</Button>
      <Button type="submit" form="reset-site-user-password" variant="primary" isLoading={isPending} loadingLabel="처리 중">비밀번호 초기화</Button>
    </>}
  >
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-control bg-surface-inset p-4"><dt>사용자</dt><dd>{user.name}</dd><dt>로그인 아이디</dt><dd>{user.loginId}</dd></dl>
    <form id="reset-site-user-password" className="mt-5 grid gap-4" onSubmit={submit} noValidate>
      <PasswordField ref={passwordRef} id="reset-temporary-password" label="새 임시 비밀번호" autoComplete="new-password" value={password} onChange={(value) => { setPassword(value); setError(""); }} />
      <PasswordField id="reset-temporary-password-confirmation" label="임시 비밀번호 확인" autoComplete="new-password" value={confirmation} onChange={(value) => { setConfirmation(value); setError(""); }} />
      {error ? <p className="rounded-control border border-status-danger-border bg-status-danger-background p-3 text-status-danger-foreground" role="alert">{error}</p> : null}
    </form>
  </ModalDialog>;
}
