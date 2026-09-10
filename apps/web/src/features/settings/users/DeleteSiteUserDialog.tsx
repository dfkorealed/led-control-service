import { useRef, useState, type FormEvent } from "react";
import { deleteSiteUser, type SiteUserSummary } from "../../../api/site-users";
import { Button, ModalDialog } from "../../../components/ui";
import { siteUserErrorMessage } from "./site-user-form";

export function DeleteSiteUserDialog({ siteId, user, returnFocusElement, fallbackFocusElement, onClose, onCompleted, onMutationError }: {
  siteId: string;
  user: SiteUserSummary;
  returnFocusElement?: HTMLElement | null;
  onClose: () => void;
  onCompleted: (message: string) => void;
  onMutationError?: (error: unknown) => Promise<string | null>;
  fallbackFocusElement?: HTMLElement | null;
}) {
  const confirmationRef = useRef<HTMLInputElement>(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);
  const pendingRef = useRef(false);
  const matches = confirmation === user.loginId;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!matches || pendingRef.current) return;
    setError("");
    pendingRef.current = true;
    setIsPending(true);
    try {
      await deleteSiteUser(siteId, user.id, confirmation);
      setConfirmation("");
      onClose();
      void onCompleted("사용자를 영구 삭제했습니다.");
    } catch (requestError) {
      const message = onMutationError ? await onMutationError(requestError) : siteUserErrorMessage(requestError);
      if (message) setError(message);
    } finally {
      pendingRef.current = false;
      setIsPending(false);
    }
  }

  return <ModalDialog
    role="alertdialog"
    title={`${user.name} 사용자 영구 삭제`}
    description="이 작업은 되돌릴 수 없습니다."
    onClose={onClose}
    isPending={isPending}
    initialFocusRef={confirmationRef}
    returnFocusElement={returnFocusElement}
    fallbackFocusElement={fallbackFocusElement}
    actions={<>
      <Button type="button" onClick={onClose} disabled={isPending}>취소</Button>
      <Button type="submit" form="delete-site-user" variant="danger" disabled={!matches} isLoading={isPending} loadingLabel="삭제 중">영구 삭제</Button>
    </>}
  >
    <div className="site-user-delete-warning">계정과 현장 소속 정보, 로그인 세션이 완전히 삭제됩니다. 기존 조명 제어 이력은 보존되며 사용자 정보만 익명화됩니다.</div>
    <form id="delete-site-user" className="site-user-form" onSubmit={submit} noValidate>
      <div className="site-user-field">
        <label htmlFor="delete-site-user-confirmation">확인 로그인 아이디</label>
        <p>확인을 위해 <strong>{user.loginId}</strong>를 정확히 입력하세요.</p>
        <input ref={confirmationRef} id="delete-site-user-confirmation" value={confirmation} onChange={(event) => { setConfirmation(event.target.value); setError(""); }} autoComplete="off" />
      </div>
      {error ? <p className="site-user-form-alert" role="alert">{error}</p> : null}
    </form>
  </ModalDialog>;
}
