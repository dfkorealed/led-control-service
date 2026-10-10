import type { FormEvent, ReactNode } from "react";
import { Button, ModalDialog, TextField } from "../../../components/ui";

interface SiteInformationEditDialogProps {
  isOpen: boolean;
  pending: boolean;
  onClose: () => void;
  returnFocusElement: HTMLElement | null;
  onSubmit: (event: FormEvent) => void;
  values: { name: string; address: string; timeZone: string; tariffKwhRate: string };
  onChange: (field: "name" | "address" | "timeZone" | "tariffKwhRate", value: string) => void;
  tariffError: string;
  children?: ReactNode;
}

/** Presentation only: the mounted site owner retains drafts, concurrency and retries. */
export function SiteInformationEditDialog({ isOpen, pending, onClose, returnFocusElement, onSubmit, values, onChange, tariffError, children }: SiteInformationEditDialogProps) {
  return <ModalDialog isOpen={isOpen} title="현장 정보 수정" onClose={onClose} isPending={pending}
    returnFocusElement={returnFocusElement}
    actions={<><Button onClick={onClose}>취소</Button><Button type="submit" form="site-information-edit" variant="primary" isLoading={pending} loadingLabel="저장 중">현장 정보 저장</Button></>}>
    <form id="site-information-edit" aria-label="현장 정보" className="grid gap-4 compact:grid-cols-2" onSubmit={onSubmit}>
      <TextField label="현장명" isRequired maxLength={120} value={values.name} onChange={value => onChange("name", value)} />
      <TextField label="주소" className="compact:col-span-2" isRequired maxLength={500} value={values.address} onChange={value => onChange("address", value)} />
      <TextField label="시간대" isRequired maxLength={100} value={values.timeZone} onChange={value => onChange("timeZone", value)} />
      <TextField label="통화" isReadOnly value="KRW" />
      <TextField label="kWh 단가" isRequired inputMode="decimal" validationBehavior="aria" isInvalid={Boolean(tariffError)} errorMessage={tariffError}
        value={values.tariffKwhRate} onChange={value => onChange("tariffKwhRate", value)} />
      <div className="compact:col-span-2">{children}</div>
    </form>
  </ModalDialog>;
}
