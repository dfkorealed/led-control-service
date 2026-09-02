import { useRef, useState } from "react";
import { ApiError } from "../../../api/client";
import { changePassword } from "../../../api/auth";
import { Button, Card, PageHeader } from "../../../components/ui";

export function PasswordSettingsView() {
  const requestInFlight = useRef(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestInFlight.current) return;

    const validationMessage = validatePasswords(currentPassword, newPassword, newPasswordConfirmation);
    if (validationMessage) {
      setSuccessMessage("");
      setErrorMessage(validationMessage);
      return;
    }

    requestInFlight.current = true;
    setIsPending(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      await changePassword({ currentPassword, newPassword, newPasswordConfirmation });
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirmation("");
      setSuccessMessage("비밀번호를 변경했습니다.");
    } catch (error) {
      setErrorMessage(isIncorrectCurrentPassword(error)
        ? "현재 비밀번호가 올바르지 않습니다."
        : "비밀번호를 변경하지 못했습니다. 잠시 후 다시 시도하세요.");
    } finally {
      requestInFlight.current = false;
      setIsPending(false);
    }
  }

  return (
    <section className="settings-screen">
      <PageHeader
        title="비밀번호 변경"
        description="현재 비밀번호를 확인한 뒤 새 비밀번호를 적용합니다."
      />
      <form className="password-settings-form" aria-label="비밀번호 변경" onSubmit={handleSubmit}>
        <Card className="setup-section password-settings-card">
          <div className="setup-form-grid">
            <label>
              현재 비밀번호
              <input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
            </label>
            <label>
              새 비밀번호
              <input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
            </label>
            <label>
              새 비밀번호 확인
              <input type="password" autoComplete="new-password" value={newPasswordConfirmation} onChange={(event) => setNewPasswordConfirmation(event.target.value)} />
            </label>
          </div>
          {errorMessage ? <p className="danger-text" role="alert">{errorMessage}</p> : null}
          {successMessage ? <p className="success-text" role="status">{successMessage}</p> : null}
          <Button variant="primary" type="submit" isLoading={isPending} loadingLabel="변경 중">
            비밀번호 변경
          </Button>
        </Card>
      </form>
    </section>
  );
}

function validatePasswords(currentPassword: string, newPassword: string, newPasswordConfirmation: string) {
  if (!currentPassword) return "현재 비밀번호를 입력하세요.";
  if (newPassword.length < 8) return "새 비밀번호는 8자 이상이어야 합니다.";
  if (newPassword !== newPasswordConfirmation) return "새 비밀번호 확인이 일치하지 않습니다.";
  return "";
}

function isIncorrectCurrentPassword(error: unknown) {
  return error instanceof ApiError
    && typeof error.body === "object"
    && error.body !== null
    && "message" in error.body
    && error.body.message === "Current password is incorrect";
}
