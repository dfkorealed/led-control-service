import { ModalDialog } from "../ModalDialog";
import { ContactEmailCard } from "./ContactEmailCard";

export function PublicContactDialog({ opener, onClose, plan }: { opener: HTMLElement | null; onClose: () => void; plan: string | null }) {
  return <ModalDialog isOpen title="도입 상담" chrome="none"
    closeLabel="상담 팝업 닫기" onClose={onClose} returnFocusElement={opener}
    className="w-[min(650px,100%)]! max-h-[calc(100dvh-32px)]! rounded-panel!"
    bodyClassName="field-day-inquiry-body">
    <ContactEmailCard onClose={onClose} plan={plan} />
  </ModalDialog>;
}
