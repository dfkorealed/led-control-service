import type { FormEvent, ReactNode } from "react";
import { Button, ModalDialog, TextField } from "../../../components/ui";

interface FloorEditDialogProps {
  isOpen: boolean;
  floorName?: string;
  pending: boolean;
  onClose: () => void;
  returnFocusElement: HTMLElement | null;
  onSubmit: (event: FormEvent) => void;
  values: { name: string; level: string; displayOrder: string };
  onChange: (field: "name" | "level" | "displayOrder", value: string) => void;
  children?: ReactNode;
}

/** Inputs keep the existing signed level and nonnegative order contracts. */
export function FloorEditDialog({ isOpen, floorName, pending, onClose, returnFocusElement, onSubmit, values, onChange, children }: FloorEditDialogProps) {
  const label = floorName ? `${floorName} 층 정보 수정` : "층 추가";
  const prefix = floorName ?? "새 층";
  return <ModalDialog isOpen={isOpen} title={floorName ? `${floorName} 층 수정` : "층 추가"} onClose={onClose} isPending={pending}
    returnFocusElement={returnFocusElement}
    actions={<><Button onClick={onClose}>취소</Button><Button type="submit" form="floor-edit" variant="primary" isLoading={pending} loadingLabel={floorName ? "저장 중" : "추가 중"}>{floorName ? `${floorName} 층 정보 저장` : "층 추가"}</Button></>}>
    <form id="floor-edit" aria-label={label} className="grid gap-4" onSubmit={onSubmit}>
      <TextField aria-label={`${prefix} 이름`} label={floorName ? "이름" : "새 층 이름"} isRequired maxLength={120} value={values.name} onChange={value => onChange("name", value)} />
      <TextField aria-label={`${prefix} 레벨`} label={floorName ? "레벨" : "새 층 레벨"} isRequired inputMode="numeric" pattern="-?[0-9]+" value={values.level} onChange={value => onChange("level", value)} />
      <TextField aria-label={`${prefix} 표시 순서`} label={floorName ? "표시 순서" : "새 층 표시 순서"} isRequired inputMode="numeric" pattern="[0-9]+" value={values.displayOrder} onChange={value => onChange("displayOrder", value)} />
      {children}
    </form>
  </ModalDialog>;
}
