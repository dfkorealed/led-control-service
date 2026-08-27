import { useRef, useState } from "react";
import type { SiteAdminSummary } from "../../../api/operator-site-admins";
import { ConfirmDialog } from "../../../components/ConfirmDialog";

interface ResetAdminPasswordDialogProps {
  admin: NonNullable<SiteAdminSummary["admin"]>;
  returnFocusElement?: HTMLElement | null;
  fallbackFocusElement?: HTMLElement | null;
  onReset: (userId: string, newPassword: string) => Promise<unknown>;
  onSuccess: () => void;
  onClose: () => void;
}

export function ResetAdminPasswordDialog({ admin, returnFocusElement, fallbackFocusElement, onReset, onSuccess, onClose }: ResetAdminPasswordDialogProps) {
  const passwordRef = useRef<HTMLInputElement>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validationError, setValidationError] = useState("");
  const [generalError, setGeneralError] = useState("");
  const [isPending, setIsPending] = useState(false);
  const submissionInFlightRef = useRef(false);

  function clearAndClose() {
    if (isPending) return;
    setNewPassword("");
    setConfirmation("");
    setValidationError("");
    setGeneralError("");
    onClose();
  }

  async function resetPassword() {
    if (submissionInFlightRef.current) return;
    submissionInFlightRef.current = true;
    setIsPending(true);
    try {
      await onReset(admin.id, newPassword);
      setNewPassword("");
      setConfirmation("");
      submissionInFlightRef.current = false;
      setIsPending(false);
      onSuccess();
      onClose();
    } catch {
      submissionInFlightRef.current = false;
      setIsPending(false);
      setGeneralError("비밀번호를 재설정하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도하세요.");
    }
  }

  function confirm() {
    setValidationError("");
    setGeneralError("");
    if (!newPassword) {
      setValidationError("새 비밀번호를 입력하세요.");
      passwordRef.current?.focus();
      return;
    }
    if (newPassword !== confirmation) {
      setValidationError("비밀번호 확인이 일치하지 않습니다.");
      return;
    }
    void resetPassword();
  }

  return (
    <ConfirmDialog
      open
      title={`${admin.name} 비밀번호 재설정`}
      description="새 비밀번호를 설정하면 현재 로그인된 세션이 종료됩니다."
      confirmLabel="비밀번호 재설정"
      confirmDisabled={!newPassword || !confirmation}
      isPending={isPending}
      returnFocusElement={returnFocusElement}
      fallbackFocusElement={fallbackFocusElement}
      initialFocusRef={passwordRef}
      onConfirm={confirm}
      onClose={clearAndClose}
    >
      <div className="operator-form">
        <label className="form-field"><span>새 비밀번호</span><input ref={passwordRef} type="password" value={newPassword} autoComplete="new-password" onChange={(event) => setNewPassword(event.target.value)} /></label>
        <label className="form-field"><span>비밀번호 확인</span><input type="password" value={confirmation} autoComplete="new-password" onChange={(event) => setConfirmation(event.target.value)} /></label>
        {validationError ? <p className="danger-text" role="alert">{validationError}</p> : null}
        {generalError ? <p className="danger-text" role="alert">{generalError}</p> : null}
      </div>
    </ConfirmDialog>
  );
}
