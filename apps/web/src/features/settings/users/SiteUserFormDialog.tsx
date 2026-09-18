import { useRef, useState, type FormEvent } from "react";
import { createSiteUser, updateSiteUser, type SiteUserSummary } from "../../../api/site-users";
import { Button, ModalDialog, PasswordField, RadioGroup, Switch, TextField } from "../../../components/ui";
import { siteUserErrorCode, siteUserErrorMessage, validateSiteUserForm, type SiteUserFormErrors, type SiteUserFormValues } from "./site-user-form";

interface SiteUserFormDialogProps {
  siteId: string;
  user?: SiteUserSummary;
  returnFocusElement?: HTMLElement | null;
  onClose: () => void;
  onCompleted: (message: string) => void;
  onLimitReached?: () => void;
  onMutationError?: (error: unknown) => Promise<string | null>;
  fallbackFocusElement?: HTMLElement | null;
}

export function SiteUserFormDialog({ siteId, user, returnFocusElement, fallbackFocusElement, onClose, onCompleted, onLimitReached, onMutationError }: SiteUserFormDialogProps) {
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
  const pendingRef = useRef(false);

  function update<K extends keyof SiteUserFormValues>(key: K, value: SiteUserFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setRequestError("");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pendingRef.current) return;
    const normalized = { ...values, name: values.name.trim(), loginId: values.loginId.trim().toLowerCase() };
    const nextErrors = validateSiteUserForm(normalized, !isEdit);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setRequestError("");
    pendingRef.current = true;
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
      onClose();
      void onCompleted(user ? "사용자 정보를 수정했습니다." : "사용자를 생성했습니다.");
    } catch (error) {
      const message = siteUserErrorMessage(error);
      if (siteUserErrorCode(error) === "USER_LIMIT_REACHED") {
        setIsLimitReached(true);
        onLimitReached?.();
      }
      const recoveredMessage = onMutationError ? await onMutationError(error) : message;
      if (!recoveredMessage) return;
      if (recoveredMessage === "이미 사용 중인 로그인 아이디입니다.") {
        setErrors((current) => ({ ...current, loginId: message }));
      } else {
        setRequestError(recoveredMessage);
      }
    } finally {
      pendingRef.current = false;
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
      fallbackFocusElement={fallbackFocusElement}
      className="w-[min(38.125rem,100%)]!"
      actions={<>
        <Button type="button" onClick={onClose} disabled={isPending}>취소</Button>
        <Button type="submit" form="site-user-form" variant="primary" disabled={isLimitReached} isLoading={isPending} loadingLabel="처리 중">
          {user ? "변경사항 저장" : "사용자 생성"}
        </Button>
      </>}
    >
      <form id="site-user-form" className="grid gap-5" onSubmit={handleSubmit} noValidate>
        <div className="grid gap-4 compact:grid-cols-2">
          <TextField ref={nameRef} id="site-user-name" label="이름" value={values.name} onChange={(value) => update("name", value)} isInvalid={Boolean(errors.name)} errorMessage={errors.name} />
          <TextField id="site-user-login" label="로그인 아이디" value={values.loginId} onChange={(value) => update("loginId", value)} autoComplete="off" isInvalid={Boolean(errors.loginId)} errorMessage={errors.loginId} />
        </div>
        {!isEdit ? (
          <PasswordField id="site-user-password" label="임시 비밀번호" description="8~1024자로 입력하세요. 공백만 사용할 수 없으며, 사용자는 최초 로그인 후 비밀번호를 변경해야 합니다." value={values.temporaryPassword} onChange={(value) => update("temporaryPassword", value)} autoComplete="new-password" isInvalid={Boolean(errors.temporaryPassword)} errorMessage={errors.temporaryPassword} />
        ) : null}
        <RadioGroup label="현장 권한" description="제어 권한에는 모니터링과 통계 조회 권한이 포함됩니다." orientation="horizontal" value={values.accessLevel} onChange={(value) => update("accessLevel", value as SiteUserFormValues["accessLevel"])} items={[{ value: "read", label: "조회" }, { value: "control", label: "제어" }]} />
        <Switch label="계정 활성화" description={isEdit ? "비활성화하면 현재 로그인 세션이 종료됩니다." : "활성 상태로 생성하면 즉시 로그인할 수 있습니다."} isSelected={values.status === "active"} onChange={(selected) => update("status", selected ? "active" : "disabled")} />
        {requestError ? <p className="rounded-control border border-status-danger-border bg-status-danger-background p-3 text-status-danger-foreground" role="alert">{requestError}</p> : null}
      </form>
    </ModalDialog>
  );
}
