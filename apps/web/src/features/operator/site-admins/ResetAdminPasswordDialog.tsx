import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { SiteAdminSummary } from "../../../api/operator-site-admins";
import { ConfirmDialog } from "../../../components/ConfirmDialog";

interface ResetAdminPasswordDialogProps {
  admin: NonNullable<SiteAdminSummary["admin"]>;
  returnFocusElement?: HTMLElement | null;
  onReset: (userId: string, newPassword: string) => Promise<unknown>;
  onSuccess: () => void;
  onClose: () => void;
}

export function ResetAdminPasswordDialog({ admin, returnFocusElement, onReset, onSuccess, onClose }: ResetAdminPasswordDialogProps) {
  const passwordRef = useRef<HTMLInputElement>(null);
  const [newPassword, setNewPassword] = useState("");
  const passwordRefValue = useRef(newPassword);
  passwordRefValue.current = newPassword;
  const [confirmation, setConfirmation] = useState("");
  const [validationError, setValidationError] = useState("");
  const [generalError, setGeneralError] = useState("");

  function clearAndClose() {
    if (mutation.isPending) return;
    setNewPassword("");
    setConfirmation("");
    setValidationError("");
    setGeneralError("");
    onClose();
  }

  const mutation = useMutation({
    // No mutation variables: React Query must never retain a plaintext password.
    mutationFn: () => onReset(admin.id, passwordRefValue.current),
    onSuccess: () => {
      setNewPassword("");
      setConfirmation("");
      onSuccess();
      onClose();
    },
    onError: () => setGeneralError("비밀번호를 재설정하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도하세요.")
  });

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
    mutation.mutate();
  }

  return (
    <ConfirmDialog
      open
      title={`${admin.name} 비밀번호 재설정`}
      description="새 비밀번호를 설정하면 현재 로그인된 세션이 종료됩니다."
      confirmLabel="비밀번호 재설정"
      confirmDisabled={!newPassword || !confirmation}
      isPending={mutation.isPending}
      returnFocusElement={returnFocusElement}
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
