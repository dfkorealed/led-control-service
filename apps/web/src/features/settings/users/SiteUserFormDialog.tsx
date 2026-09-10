import { useRef, useState, type FormEvent } from "react";
import { createSiteUser, updateSiteUser, type SiteUserSummary } from "../../../api/site-users";
import { Button, ModalDialog } from "../../../components/ui";
import { siteUserErrorCode, siteUserErrorMessage, validateSiteUserForm, type SiteUserFormErrors, type SiteUserFormValues } from "./site-user-form";

interface SiteUserFormDialogProps {
  siteId: string;
  user?: SiteUserSummary;
  returnFocusElement?: HTMLElement | null;
  onClose: () => void;
  onCompleted: (message: string) => Promise<void>;
  onLimitReached?: () => void;
}

export function SiteUserFormDialog({ siteId, user, returnFocusElement, onClose, onCompleted, onLimitReached }: SiteUserFormDialogProps) {
  const isEdit = Boolean(user);
  const nameRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<SiteUserFormValues>({
    name: user?.name ?? "",
    loginId: user?.loginId ?? "",
    temporaryPassword: "",
    accessLevel: user?.accessLevel ?? "read",
    status: user?.status ?? "active"
  });
  const [errors, setErrors] = useState<SiteUserFormErrors>({});
  const [requestError, setRequestError] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [isLimitReached, setIsLimitReached] = useState(false);

  function update<K extends keyof SiteUserFormValues>(key: K, value: SiteUserFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setRequestError("");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const normalized = { ...values, name: values.name.trim(), loginId: values.loginId.trim().toLowerCase() };
    const nextErrors = validateSiteUserForm(normalized, !isEdit);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setRequestError("");
    setIsPending(true);
    try {
      if (user) {
        await updateSiteUser(siteId, user.id, {
          name: normalized.name,
          loginId: normalized.loginId,
          accessLevel: normalized.accessLevel,
          status: normalized.status,
          expectedUpdatedAt: user.updatedAt
        });
      } else {
        await createSiteUser(siteId, {
          name: normalized.name,
          loginId: normalized.loginId,
          temporaryPassword: normalized.temporaryPassword,
          accessLevel: normalized.accessLevel,
          status: normalized.status
        });
      }
      setValues((current) => ({ ...current, temporaryPassword: "" }));
      await onCompleted(user ? "사용자 정보를 수정했습니다." : "사용자를 생성했습니다.");
      onClose();
    } catch (error) {
      const message = siteUserErrorMessage(error);
      if (siteUserErrorCode(error) === "USER_LIMIT_REACHED") {
        setIsLimitReached(true);
        onLimitReached?.();
      }
      if (message === "이미 사용 중인 로그인 아이디입니다.") {
        setErrors((current) => ({ ...current, loginId: message }));
      } else {
        setRequestError(message);
      }
    } finally {
      setIsPending(false);
    }
  }

  return (
    <ModalDialog
      title={user ? `${user.name} 사용자 수정` : "사용자 추가"}
      description={user
        ? "사용자 정보, 현장 권한과 계정 상태를 변경합니다."
        : "임시 비밀번호로 계정을 만들며, 사용자는 최초 로그인 후 비밀번호를 변경해야 합니다."}
      onClose={onClose}
      isPending={isPending}
      initialFocusRef={nameRef}
      returnFocusElement={returnFocusElement}
      className="site-user-dialog-wide"
      actions={<>
        <Button type="button" onClick={onClose} disabled={isPending}>취소</Button>
        <Button type="submit" form="site-user-form" variant="primary" disabled={isLimitReached} isLoading={isPending} loadingLabel="처리 중">
          {user ? "변경사항 저장" : "사용자 생성"}
        </Button>
      </>}
    >
      <form id="site-user-form" className="site-user-form" onSubmit={handleSubmit} noValidate>
        <div className="site-user-form-grid">
          <FormField label="이름" error={errors.name}>
            <input ref={nameRef} id="site-user-name" value={values.name} onChange={(event) => update("name", event.target.value)} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? "site-user-name-error" : undefined} />
          </FormField>
          <FormField label="로그인 아이디" error={errors.loginId} errorId="site-user-login-error">
            <input id="site-user-login" value={values.loginId} onChange={(event) => update("loginId", event.target.value)} autoCapitalize="none" autoComplete="off" aria-invalid={Boolean(errors.loginId)} aria-describedby={errors.loginId ? "site-user-login-error" : undefined} />
          </FormField>
        </div>
        {!isEdit ? (
          <FormField label="임시 비밀번호" error={errors.temporaryPassword} errorId="site-user-password-error" help="8자 이상 입력하세요. 사용자는 최초 로그인 후 비밀번호를 변경해야 합니다.">
            <input id="site-user-password" type="password" value={values.temporaryPassword} onChange={(event) => update("temporaryPassword", event.target.value)} autoComplete="new-password" aria-invalid={Boolean(errors.temporaryPassword)} aria-describedby={errors.temporaryPassword ? "site-user-password-error" : undefined} />
          </FormField>
        ) : null}
        <fieldset className="site-user-segments">
          <legend>현장 권한</legend>
          <div>
            {(["read", "control"] as const).map((level) => (
              <button key={level} type="button" aria-pressed={values.accessLevel === level} onClick={() => update("accessLevel", level)}>
                {level === "read" ? "조회" : "제어"}
              </button>
            ))}
          </div>
          <p>제어 권한에는 모니터링과 통계 조회 권한이 포함됩니다.</p>
        </fieldset>
        <label className="site-user-status-control">
          <span><strong>계정 활성화</strong><small>{isEdit ? "비활성화하면 현재 로그인 세션이 종료됩니다." : "활성 상태로 생성하면 즉시 로그인할 수 있습니다."}</small></span>
          <input type="checkbox" role="switch" checked={values.status === "active"} onChange={(event) => update("status", event.target.checked ? "active" : "disabled")} />
        </label>
        {requestError ? <p className="site-user-form-alert" role="alert">{requestError}</p> : null}
      </form>
    </ModalDialog>
  );
}

function FormField({ label, error, errorId, help, children }: { label: string; error?: string; errorId?: string; help?: string; children: React.ReactElement<{ id?: string }> }) {
  const id = children.props.id;
  return <div className="site-user-field"><label htmlFor={id}>{label}</label>{children}{error ? <small id={errorId ?? `${id}-error`} role="alert" className="site-user-field-error">{error}</small> : help ? <small>{help}</small> : null}</div>;
}
