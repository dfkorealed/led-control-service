import { CircleCheck, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { changePassword } from "../../../api/auth";
import { refreshPrincipalCache } from "../../../api/principal-cache";
import { Button, Card, FeedbackState, PageHeader } from "../../../components/ui";
import { passwordChangeErrorMessage, validatePasswordChange } from "../../auth/password-form";

export function PasswordSettingsView() {
  const queryClient = useQueryClient();
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
      const result = await changePassword({ currentPassword, newPassword, newPasswordConfirmation });
      await refreshPrincipalCache(queryClient, { user: result.user });
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirmation("");
      setSuccessMessage("비밀번호를 변경했습니다.");
    } catch (error) {
      setErrorMessage(passwordChangeErrorMessage(error, "비밀번호를 변경하지 못했습니다. 잠시 후 다시 시도하세요."));
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
              <input type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
            </label>
            <label>
              새 비밀번호 확인
              <input type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={newPasswordConfirmation} onChange={(event) => setNewPasswordConfirmation(event.target.value)} />
            </label>
          </div>
          {errorMessage ? (
            <FeedbackState tone="danger" icon={TriangleAlert} title="비밀번호를 변경하지 못했습니다." description={errorMessage} />
          ) : null}
          {successMessage ? (
            <FeedbackState tone="success" icon={CircleCheck} title={successMessage} />
          ) : null}
          <Button variant="primary" type="submit" isLoading={isPending} loadingLabel="변경 중">
            비밀번호 변경
          </Button>
        </Card>
      </form>
    </section>
  );
}

function validatePasswords(currentPassword: string, newPassword: string, newPasswordConfirmation: string) {
  return validatePasswordChange(currentPassword, newPassword, newPasswordConfirmation);
}
