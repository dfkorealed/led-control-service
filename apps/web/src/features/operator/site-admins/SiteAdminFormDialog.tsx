import { useMutation } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AssignSiteAdminInput, CreateSiteAdminInput, SiteAdminSummary, UpdateSiteAdminInput } from "../../../api/operator-site-admins";
import { Button, FeedbackState, ModalDialog, PasswordField, TextField } from "../../../components/ui";
import { MIN_OPERATOR_PASSWORD_LENGTH, OPERATOR_PASSWORD_POLICY_MESSAGE, isPasswordPolicyError } from "./password-policy";

type FormMode = "create" | "assign" | "edit";

interface SiteAdminFormDialogProps {
  mode: FormMode;
  site?: SiteAdminSummary;
  admin?: NonNullable<SiteAdminSummary["admin"]>;
  returnFocusElement?: HTMLElement | null;
  fallbackFocusElement?: HTMLElement | null;
  onCreate: (input: CreateSiteAdminInput) => Promise<unknown>;
  onAssign: (siteId: string, input: AssignSiteAdminInput) => Promise<unknown>;
  onUpdate: (userId: string, input: UpdateSiteAdminInput) => Promise<unknown>;
  onSuccess: (message: string) => Promise<unknown>;
  onClose: () => void;
}

type FormState = {
  customerName: string;
  siteName: string;
  adminName: string;
  loginId: string;
  initialPassword: string;
};

const emptyForm: FormState = { customerName: "", siteName: "", adminName: "", loginId: "", initialPassword: "" };

export function SiteAdminFormDialog({
  mode,
  site,
  admin,
  returnFocusElement,
  fallbackFocusElement,
  onCreate,
  onAssign,
  onUpdate,
  onSuccess,
  onClose
}: SiteAdminFormDialogProps) {
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const loginIdRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<FormState>(() => ({
    ...emptyForm,
    adminName: admin?.name ?? "",
    loginId: admin?.loginId ?? ""
  }));
  const [loginIdError, setLoginIdError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [generalError, setGeneralError] = useState("");
  const [isSubmittingPasswordFlow, setIsSubmittingPasswordFlow] = useState(false);
  const passwordSubmissionInFlightRef = useRef(false);
  const editInputRef = useRef<UpdateSiteAdminInput>({ adminName: admin?.name ?? "", loginId: admin?.loginId ?? "" });
  editInputRef.current = { adminName: form.adminName.trim(), loginId: form.loginId.trim() };

  useEffect(() => {
    if (loginIdError) loginIdRef.current?.focus();
  }, [loginIdError]);

  function close() {
    if (isPending) return;
    setForm(emptyForm);
    setLoginIdError("");
    setPasswordError("");
    setGeneralError("");
    onClose();
  }

  const editMutation = useMutation({
    mutationFn: () => {
      if (!admin) throw new Error("관리자 계정 대상이 없습니다.");
      return onUpdate(admin.id, editInputRef.current);
    },
    onSuccess: async () => {
      setForm(emptyForm);
      try {
        await onSuccess("관리자 정보를 수정했습니다.");
      } catch {
        // A completed account mutation must not remain open when its post-success refetch fails.
      } finally {
        onClose();
      }
    },
    onError: (error) => {
      if (isLoginIdDuplicate(error)) {
        setLoginIdError("이미 사용 중인 로그인 아이디입니다.");
      } else {
        setGeneralError("관리자 계정 변경을 완료하지 못했습니다. 잠시 후 다시 시도하세요.");
      }
    }
  });

  const needsPassword = mode !== "edit";
  const isPending = needsPassword ? isSubmittingPasswordFlow : editMutation.isPending;
  const valid = Boolean(form.adminName.trim() && form.loginId.trim()
    && (!needsPassword || form.initialPassword)
    && (mode !== "create" || (form.customerName.trim() && form.siteName.trim())));
  const title = mode === "create"
    ? "현장 및 관리자 생성"
    : mode === "assign"
      ? `${site?.siteName ?? "현장"} 관리자 지정`
      : `${admin?.name ?? "관리자"} 수정`;
  const submitLabel = mode === "create" ? "생성" : mode === "assign" ? "지정" : "저장";

  async function submitPasswordFlow() {
    if (passwordSubmissionInFlightRef.current) return;
    if (form.initialPassword.length < MIN_OPERATOR_PASSWORD_LENGTH) {
      setPasswordError(OPERATOR_PASSWORD_POLICY_MESSAGE);
      passwordRef.current?.focus();
      return;
    }
    passwordSubmissionInFlightRef.current = true;
    const current = form;
    setLoginIdError("");
    setPasswordError("");
    setGeneralError("");
    setIsSubmittingPasswordFlow(true);

    try {
      if (mode === "create") {
        await onCreate({
          customerName: current.customerName.trim(),
          siteName: current.siteName.trim(),
          adminName: current.adminName.trim(),
          loginId: current.loginId.trim(),
          initialPassword: current.initialPassword
        });
        setForm(emptyForm);
        await completePasswordSuccess("현장과 관리자 계정을 생성했습니다.");
        return;
      }
      if (mode === "assign" && site) {
        await onAssign(site.siteId, {
          adminName: current.adminName.trim(),
          loginId: current.loginId.trim(),
          initialPassword: current.initialPassword
        });
        setForm(emptyForm);
        await completePasswordSuccess("현장 관리자를 지정했습니다.");
        return;
      }
      throw new Error("관리자 계정 대상이 없습니다.");
    } catch (error) {
      passwordSubmissionInFlightRef.current = false;
      setIsSubmittingPasswordFlow(false);
      if (isLoginIdDuplicate(error)) {
        setLoginIdError("이미 사용 중인 로그인 아이디입니다.");
      } else if (isPasswordPolicyError(error)) {
        setPasswordError(OPERATOR_PASSWORD_POLICY_MESSAGE);
        passwordRef.current?.focus();
      } else {
        setGeneralError("관리자 계정 변경을 완료하지 못했습니다. 잠시 후 다시 시도하세요.");
      }
    }
  }

  async function completePasswordSuccess(message: string) {
    try {
      await onSuccess(message);
    } catch {
      // A completed account mutation must not remain open when its post-success refetch fails.
    } finally {
      passwordSubmissionInFlightRef.current = false;
      setIsSubmittingPasswordFlow(false);
      onClose();
    }
  }

  const formId = `site-admin-form-${mode}`;

  return (
    <ModalDialog
      isOpen
      title={title}
      className="max-w-lg"
      closeLabel={`${title} 닫기`}
      isPending={isPending}
      initialFocusRef={initialFocusRef}
      returnFocusElement={returnFocusElement}
      fallbackFocusElement={fallbackFocusElement}
      onClose={close}
      actions={<>
        <Button type="button" onClick={close} disabled={isPending}>취소</Button>
        <Button form={formId} variant="primary" type="submit" disabled={!valid || isPending} isLoading={isPending} loadingLabel="처리 중">{submitLabel}</Button>
      </>}
    >
        <form id={formId} className="grid gap-3.5" onSubmit={(event) => {
          event.preventDefault();
          if (!valid || isPending) return;
          if (mode === "edit") editMutation.mutate();
          else void submitPasswordFlow();
        }}>
          {mode === "create" ? (
            <div className="grid grid-cols-2 gap-3 max-compact:grid-cols-1">
              <TextField ref={initialFocusRef} label="고객사명" value={form.customerName} onChange={(value) => setForm({ ...form, customerName: value })} />
              <TextField label="현장명" value={form.siteName} onChange={(value) => setForm({ ...form, siteName: value })} />
            </div>
          ) : null}
          <TextField label="관리자 이름" ref={mode === "create" ? undefined : initialFocusRef} value={form.adminName} onChange={(value) => setForm({ ...form, adminName: value })} />
          <TextField
            label="로그인 아이디"
            ref={loginIdRef}
            value={form.loginId}
            isInvalid={Boolean(loginIdError)}
            errorMessage={loginIdError}
            autoComplete="username"
            onChange={(value) => {
              setLoginIdError("");
              setForm({ ...form, loginId: value });
            }}
          />
          {needsPassword ? (
            <PasswordField
              ref={passwordRef}
              label="초기 비밀번호"
              value={form.initialPassword}
              isInvalid={Boolean(passwordError)}
              errorMessage={passwordError}
              autoComplete="new-password"
              onChange={(value) => {
                setPasswordError("");
                setForm({ ...form, initialPassword: value });
              }}
            />
          ) : null}
          {generalError ? <FeedbackState tone="danger" icon={CircleAlert} title={generalError} /> : null}
        </form>
    </ModalDialog>
  );
}

function isLoginIdDuplicate(error: unknown) {
  if (typeof error !== "object" || error === null || !("status" in error) || !("body" in error)) return false;
  const apiError = error as { status?: unknown; body?: unknown };
  return apiError.status === 409
    && typeof apiError.body === "object"
    && apiError.body !== null
    && "message" in apiError.body
    && (apiError.body as { message?: unknown }).message === "loginId already exists";
}
