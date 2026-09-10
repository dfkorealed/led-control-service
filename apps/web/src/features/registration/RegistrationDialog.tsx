import { X } from "lucide-react";
import { useRef, type RefObject } from "react";
import type { Dashboard } from "../../api/queries";
import { useModalFocus } from "../control/useModalFocus";
import { RegistrationPanel } from "./RegistrationPanel";

interface RegistrationDialogProps {
  open: boolean;
  dashboard: Dashboard;
  dashboardQuerySiteId?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}

export function RegistrationDialog({
  open,
  dashboard,
  dashboardQuerySiteId,
  returnFocusRef,
  onClose
}: RegistrationDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocus({ open, dialogRef, returnFocusRef, onClose });

  if (!open) return null;

  return (
    <div className="registration-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section
        ref={dialogRef}
        className="registration-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="registration-dialog-title"
        tabIndex={-1}
      >
        <header className="registration-dialog-header">
          <div>
            <span className="eyebrow">조명 관리</span>
            <h2 id="registration-dialog-title">조명 등록</h2>
          </div>
          <button className="icon-button" type="button" aria-label="조명 등록 닫기" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="registration-dialog-content">
          <RegistrationPanel dashboard={dashboard} dashboardQuerySiteId={dashboardQuerySiteId} />
        </div>
      </section>
    </div>
  );
}
