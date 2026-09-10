import { useRef, useState, type FormEvent } from "react";
import { resetSiteUserPassword, type SiteUserSummary } from "../../../api/site-users";
import { Button, ModalDialog } from "../../../components/ui";
import { siteUserErrorMessage } from "./site-user-form";

export function ResetSiteUserPasswordDialog({ siteId, user, returnFocusElement, onClose, onCompleted }: {
  siteId: string;
  user: SiteUserSummary;
  returnFocusElement?: HTMLElement | null;
  onClose: () => void;
  onCompleted: (message: string) => Promise<void>;
}) {
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 8) return setError("임시 비밀번호는 8자 이상 입력하세요.");
    if (password !== confirmation) return setError("임시 비밀번호 확인이 일치하지 않습니다.");
    setError("");
    setIsPending(true);
    try {
      await resetSiteUserPassword(siteId, user.id, password);
      setPassword("");
      setConfirmation("");
      await onCompleted("비밀번호를 초기화했습니다. 사용자의 기존 세션이 종료되었습니다.");
      onClose();
    } catch (requestError) {
      setError(siteUserErrorMessage(requestError));
    } finally {
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
    actions={<>
      <Button type="button" onClick={onClose} disabled={isPending}>취소</Button>
      <Button type="submit" form="reset-site-user-password" variant="primary" isLoading={isPending} loadingLabel="처리 중">비밀번호 초기화</Button>
    </>}
  >
    <dl className="site-user-account-summary"><dt>사용자</dt><dd>{user.name}</dd><dt>로그인 아이디</dt><dd>{user.loginId}</dd></dl>
    <form id="reset-site-user-password" className="site-user-form" onSubmit={submit} noValidate>
      <div className="site-user-field"><label htmlFor="reset-temporary-password">새 임시 비밀번호</label><input ref={passwordRef} id="reset-temporary-password" type="password" autoComplete="new-password" value={password} onChange={(event) => { setPassword(event.target.value); setError(""); }} /></div>
      <div className="site-user-field"><label htmlFor="reset-temporary-password-confirmation">임시 비밀번호 확인</label><input id="reset-temporary-password-confirmation" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => { setConfirmation(event.target.value); setError(""); }} /></div>
      {error ? <p className="site-user-form-alert" role="alert">{error}</p> : null}
    </form>
  </ModalDialog>;
}
