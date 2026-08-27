import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AssignSiteAdminInput, CreateSiteAdminInput, SiteAdminSummary, UpdateSiteAdminInput } from "../../../api/operator-site-admins";
import { useDialogFocus } from "../../../components/ConfirmDialog";

type FormMode = "create" | "assign" | "edit";

interface SiteAdminFormDialogProps {
  mode: FormMode;
  site?: SiteAdminSummary;
  admin?: NonNullable<SiteAdminSummary["admin"]>;
  returnFocusElement?: HTMLElement | null;
  onCreate: (input: CreateSiteAdminInput) => Promise<unknown>;
  onAssign: (siteId: string, input: AssignSiteAdminInput) => Promise<unknown>;
  onUpdate: (userId: string, input: UpdateSiteAdminInput) => Promise<unknown>;
  onSuccess: (message: string) => void;
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
  onCreate,
  onAssign,
  onUpdate,
  onSuccess,
  onClose
}: SiteAdminFormDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const loginIdRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<FormState>(() => ({
    ...emptyForm,
    adminName: admin?.name ?? "",
    loginId: admin?.loginId ?? ""
  }));
  const formRef = useRef(form);
  formRef.current = form;
  const [loginIdError, setLoginIdError] = useState("");
  const [generalError, setGeneralError] = useState("");

  useEffect(() => {
    if (loginIdError) loginIdRef.current?.focus();
  }, [loginIdError]);

  function close() {
    if (mutation.isPending) return;
    setForm(emptyForm);
    setLoginIdError("");
    setGeneralError("");
    onClose();
  }

  useDialogFocus({ open: true, dialogRef, returnFocusElement, onClose: close, initialFocusRef });

  const mutation = useMutation({
    // Calling mutate() without variables keeps password fields out of React Query's mutation cache.
    mutationFn: () => {
      const current = formRef.current;
      if (mode === "create") {
        return onCreate({
          customerName: current.customerName.trim(),
          siteName: current.siteName.trim(),
          adminName: current.adminName.trim(),
          loginId: current.loginId.trim(),
          initialPassword: current.initialPassword
        });
      }
      if (mode === "assign" && site) {
        return onAssign(site.siteId, {
          adminName: current.adminName.trim(),
          loginId: current.loginId.trim(),
          initialPassword: current.initialPassword
        });
      }
      if (mode === "edit" && admin) {
        return onUpdate(admin.id, { adminName: current.adminName.trim(), loginId: current.loginId.trim() });
      }
      throw new Error("관리자 계정 대상이 없습니다.");
    },
    onSuccess: () => {
      setForm(emptyForm);
      onSuccess(mode === "create" ? "현장과 관리자 계정을 생성했습니다." : mode === "assign" ? "현장 관리자를 지정했습니다." : "관리자 정보를 수정했습니다.");
      onClose();
    },
    onError: (error) => {
      if (isConflict(error)) {
        setLoginIdError("이미 사용 중인 로그인 아이디입니다.");
      } else {
        setGeneralError("관리자 계정 변경을 완료하지 못했습니다. 입력과 연결 상태를 확인해 주세요.");
      }
    }
  });

  const needsPassword = mode !== "edit";
  const valid = Boolean(form.adminName.trim() && form.loginId.trim()
    && (!needsPassword || form.initialPassword)
    && (mode !== "create" || (form.customerName.trim() && form.siteName.trim())));
  const title = mode === "create"
    ? "현장 및 관리자 생성"
    : mode === "assign"
      ? `${site?.siteName ?? "현장"} 관리자 지정`
      : `${admin?.name ?? "관리자"} 수정`;
  const submitLabel = mode === "create" ? "생성" : mode === "assign" ? "지정" : "저장";

  return (
    <div className="operator-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) close();
    }}>
      <section ref={dialogRef} className="operator-dialog" role="dialog" aria-modal="true" aria-labelledby="site-admin-form-dialog-title" tabIndex={-1}>
        <header className="operator-dialog-header">
          <h2 id="site-admin-form-dialog-title">{title}</h2>
          <button className="icon-button" type="button" aria-label={`${title} 닫기`} onClick={close} disabled={mutation.isPending}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <form className="operator-form" onSubmit={(event) => {
          event.preventDefault();
          if (valid && !mutation.isPending) mutation.mutate();
        }}>
          {mode === "create" ? (
            <div className="operator-form-grid">
              <label className="form-field"><span>고객사명</span><input ref={initialFocusRef} value={form.customerName} onChange={(event) => setForm({ ...form, customerName: event.target.value })} /></label>
              <label className="form-field"><span>현장명</span><input value={form.siteName} onChange={(event) => setForm({ ...form, siteName: event.target.value })} /></label>
            </div>
          ) : null}
          <label className="form-field">
            <span>관리자 이름</span>
            <input ref={mode === "create" ? undefined : initialFocusRef} value={form.adminName} onChange={(event) => setForm({ ...form, adminName: event.target.value })} />
          </label>
          <label className="form-field">
            <span>로그인 아이디</span>
            <input ref={loginIdRef} value={form.loginId} aria-invalid={Boolean(loginIdError)} aria-describedby={loginIdError ? "site-admin-login-id-error" : undefined} autoComplete="username" onChange={(event) => {
              setLoginIdError("");
              setForm({ ...form, loginId: event.target.value });
            }} />
            {loginIdError ? <span id="site-admin-login-id-error" className="field-error" role="alert">{loginIdError}</span> : null}
          </label>
          {needsPassword ? (
            <label className="form-field">
              <span>초기 비밀번호</span>
              <input type="password" value={form.initialPassword} autoComplete="new-password" onChange={(event) => setForm({ ...form, initialPassword: event.target.value })} />
            </label>
          ) : null}
          {generalError ? <p className="danger-text" role="alert">{generalError}</p> : null}
          <footer className="operator-dialog-actions">
            <button type="button" onClick={close} disabled={mutation.isPending}>취소</button>
            <button className="primary-button" type="submit" disabled={!valid || mutation.isPending}>{mutation.isPending ? "처리 중" : submitLabel}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function isConflict(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error && (error as { status?: unknown }).status === 409;
}
