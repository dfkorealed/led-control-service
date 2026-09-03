import { useMutation } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useRef, useState } from "react";
import type { SiteAdminSummary } from "../../../api/operator-site-admins";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { FeedbackState } from "../../../components/ui/FeedbackState";

interface DeleteSiteDialogProps {
  site: SiteAdminSummary;
  returnFocusElement?: HTMLElement | null;
  fallbackFocusElement?: HTMLElement | null;
  onDelete: (userId: string, confirmationSiteName: string) => Promise<unknown>;
  onSuccess: () => Promise<unknown>;
  onClose: () => void;
}

export function DeleteSiteDialog({ site, returnFocusElement, fallbackFocusElement, onDelete, onSuccess, onClose }: DeleteSiteDialogProps) {
  const [confirmationSiteName, setConfirmationSiteName] = useState("");
  const confirmationRef = useRef<HTMLInputElement>(null);
  const admin = site.admin!;
  const mutation = useMutation({
    mutationFn: () => onDelete(admin.id, confirmationSiteName),
    onSuccess: async () => {
      try {
        await onSuccess();
      } catch {
        // A completed delete mutation must not remain open when its post-success refetch fails.
      } finally {
        onClose();
      }
    }
  });

  function close() {
    if (!mutation.isPending) {
      onClose();
    }
  }

  return (
    <ConfirmDialog
      open
      title={`${admin.name} 삭제`}
      description="관리자뿐 아니라 현장과 관련 데이터가 영구 삭제됩니다. 삭제 후에는 복구할 수 없습니다."
      confirmLabel="영구 삭제"
      destructive
      isPending={mutation.isPending}
      confirmDisabled={confirmationSiteName !== site.siteName}
      returnFocusElement={returnFocusElement}
      fallbackFocusElement={fallbackFocusElement}
      initialFocusRef={confirmationRef}
      onConfirm={() => mutation.mutate()}
      onClose={close}
    >
      <p className="muted-text">계속하려면 현장명 <strong>{site.siteName}</strong>을 정확히 입력하세요.</p>
      <label className="form-field">
        <span>삭제할 현장명</span>
        <input
          ref={confirmationRef}
          value={confirmationSiteName}
          autoComplete="off"
          disabled={mutation.isPending}
          onChange={(event) => setConfirmationSiteName(event.target.value)}
        />
      </label>
      {mutation.error ? <FeedbackState tone="danger" icon={CircleAlert} title="현장과 관리자 계정을 삭제하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도하세요." /> : null}
    </ConfirmDialog>
  );
}
