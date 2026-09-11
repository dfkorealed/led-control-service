import { CircleCheck, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { changePassword, type AuthUser } from "../../../api/auth";
import { authMeQueryKey, principalKey, refreshPrincipalCache } from "../../../api/principal-cache";
import { Button, Card, FeedbackState, PageHeader } from "../../../components/ui";
import { passwordChangeErrorMessage, validatePasswordChange } from "../../auth/password-form";

export function PasswordSettingsView() {
  const queryClient = useQueryClient();
  const requestInFlight = useRef(false);
  const mountedRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  useEffect(() => {
    mountedRef.current = true;
    const lifecycle = ++lifecycleGenerationRef.current;
    return () => {
      if (lifecycleGenerationRef.current === lifecycle) {
        mountedRef.current = false;
        lifecycleGenerationRef.current += 1;
      }
      requestInFlight.current = false;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestInFlight.current) return;

    const validationMessage = validatePasswords(currentPassword, newPassword, newPasswordConfirmation);
    if (validationMessage) {
      setSuccessMessage("");
      setErrorMessage(validationMessage);
      return;
    }

    const authAtStart = queryClient.getQueryData<{ user?: AuthUser } | null>(authMeQueryKey);
    if (!authAtStart?.user) {
      setErrorMessage("로그인 상태가 변경되었습니다. 다시 로그인해 주세요.");
      return;
    }

    requestInFlight.current = true;
    const operation = {
      id: ++operationGenerationRef.current,
      lifecycle: lifecycleGenerationRef.current,
      principal: principalKey(authAtStart.user),
    };
    const isCurrentOperation = () => mountedRef.current
      && lifecycleGenerationRef.current === operation.lifecycle
      && operationGenerationRef.current === operation.id;
    setIsPending(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      const result = await changePassword({ currentPassword, newPassword, newPasswordConfirmation });
      const applied = await refreshPrincipalCache(queryClient, { user: result.user }, {
        expectedPrincipalKey: operation.principal,
        isOperationCurrent: isCurrentOperation,
      });
      if (!applied || !isCurrentOperation()) return;
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirmation("");
      setSuccessMessage("비밀번호를 변경했습니다.");
    } catch (error) {
      if (!isCurrentOperation()) return;
      setErrorMessage(passwordChangeErrorMessage(error, "비밀번호를 변경하지 못했습니다. 잠시 후 다시 시도하세요."));
    } finally {
      if (isCurrentOperation()) {
        requestInFlight.current = false;
        setIsPending(false);
      }
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
