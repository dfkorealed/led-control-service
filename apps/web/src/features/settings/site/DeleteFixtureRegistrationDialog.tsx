import type { FixtureRegistrationRemovalPreview } from "@led-control/shared/fixture-registration-removal-contracts";
import { CircleAlert } from "lucide-react";
import { Button, ConfirmDialog, FeedbackState, LoadingState } from "../../../components/ui";

export interface DeleteFixtureRegistrationDialogProps {
  fixtureName: string;
  serialNumber: string | null;
  preview?: FixtureRegistrationRemovalPreview;
  loading: boolean;
  pending: boolean;
  error: string;
  notice?: string;
  trigger: HTMLElement | null;
  onRetryPreview(): void;
  onConfirm(): void;
  onClose(): void;
}

export function DeleteFixtureRegistrationDialog({ fixtureName, serialNumber, preview, loading, pending, error, notice, trigger,
  onRetryPreview, onConfirm, onClose }: DeleteFixtureRegistrationDialogProps) {
  return <ConfirmDialog role="alertdialog" title="조명 등록 삭제" confirmLabel="등록 삭제" tone="danger"
    onConfirm={onConfirm} onCancel={onClose} isPending={pending} confirmDisabled={loading || !preview?.allowed || Boolean(error)}
    returnFocusElement={trigger}>
    <div className="grid min-w-0 gap-4">
      <dl className="grid min-w-0 gap-2">
        <div><dt className="text-body-sm text-content-secondary">조명</dt><dd className="m-0 wrap-anywhere font-bold">{preview?.fixtureName ?? fixtureName}</dd></div>
        <div><dt className="text-body-sm text-content-secondary">시리얼</dt><dd className="m-0 wrap-anywhere">{preview ? preview.serialNumber ?? "확인되지 않음" : serialNumber ?? "확인되지 않음"}</dd></div>
      </dl>
      <p className="m-0">운영 목록과 맵에서 제거됩니다. 과거 통계와 제어 이력은 이력 조회용으로 보존됩니다.</p>
      <p className="m-0 font-bold">공장 초기화·소등·밝기 또는 센서 모드 변경은 하지 않습니다. 장비 자체 센서 동작은 계속될 수 있습니다.</p>
      {notice ? <p className="m-0 font-bold" role="status">{notice}</p> : null}
      {loading ? <LoadingState title="삭제 가능 여부를 확인하는 중입니다." /> : null}
      {preview && !preview.allowed ? <div role="alert" className="grid gap-2">
        <strong>등록을 삭제할 수 없습니다.</strong>
        <ul className="m-0 grid gap-2 pl-5">{preview.blockedReasons.map((reason, index) => <li key={`${reason.code}:${index}`}>{reason.message}</li>)}</ul>
        <Button onClick={onRetryPreview}>삭제 가능 여부 다시 확인</Button>
      </div> : null}
      {error ? <FeedbackState tone="danger" icon={CircleAlert} title={error}
        action={<Button onClick={onRetryPreview}>삭제 가능 여부 다시 확인</Button>} /> : null}
    </div>
  </ConfirmDialog>;
}
