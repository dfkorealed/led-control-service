import { useMutation } from "@tanstack/react-query";
import type { SiteAdminSummary } from "../../../api/operator-site-admins";
import { ConfirmDialog } from "../../../components/ConfirmDialog";

interface DisableSiteAdminDialogProps {
  admin: NonNullable<SiteAdminSummary["admin"]>;
  returnFocusElement?: HTMLElement | null;
  onDisable: (userId: string) => Promise<unknown>;
  onSuccess: () => void;
  onClose: () => void;
}

export function DisableSiteAdminDialog({ admin, returnFocusElement, onDisable, onSuccess, onClose }: DisableSiteAdminDialogProps) {
  const mutation = useMutation({
    mutationFn: () => onDisable(admin.id),
    onSuccess: () => {
      onSuccess();
      onClose();
    }
  });

  function close() {
    if (!mutation.isPending) onClose();
  }

  return (
    <ConfirmDialog
      open
      title={`${admin.name} 비활성화`}
      description="로그아웃되며 현장 접근이 중단됩니다. 운영 이력은 보존됩니다."
      confirmLabel="비활성화"
      destructive
      isPending={mutation.isPending}
      returnFocusElement={returnFocusElement}
      onConfirm={() => mutation.mutate()}
      onClose={close}
    >
      {mutation.error ? <p className="danger-text" role="alert">관리자 계정을 비활성화하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도하세요.</p> : null}
    </ConfirmDialog>
  );
}
