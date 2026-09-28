import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Button } from "../Button";

/** The archived concept owns a persistent native top-layer dialog. Its form and
 * retry identity survive closing; the browser owns ordinary modal focus trapping. */
export function NativeDialog({ isOpen, isPending, onClose, returnFocusElement, title, description, children, closeButtonRef, submitButtonRef }: {
  isOpen: boolean; isPending: boolean; onClose(): void; returnFocusElement: HTMLElement | null;
  closeButtonRef: RefObject<HTMLButtonElement>; submitButtonRef: RefObject<HTMLButtonElement>;
  title: string; description: string; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const close = closeButtonRef;
  useEffect(() => {
    const node = dialog.current!;
    if (!isOpen) { if (node.open) node.close(); return; }
    node.showModal(); heading.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [isOpen]);
  return <dialog ref={dialog} aria-labelledby="concept-inquiry-title" aria-describedby="concept-inquiry-description"
    className="inquiry-dialog fixed inset-0 m-auto w-[min(650px,calc(100%-32px))] max-w-none max-h-[calc(100dvh-32px)] overflow-auto rounded-landing-inquiry-modal border border-border-default bg-surface-panel p-0 font-landing leading-landing-concept-document text-brand-navy break-keep antialiased shadow-landing-concept-inquiry-modal backdrop:bg-surface-inverse/72 backdrop:backdrop-blur-[5px] landing-stack:w-[calc(100%-20px)] landing-stack:max-h-[calc(100dvh-20px)] landing-stack:rounded-landing-concept-inquiry-modal-stacked"
    onCancel={event => { if (isPending) event.preventDefault(); }}
    onClose={() => { onClose(); returnFocusElement?.focus(); }}
    onClick={event => { if (!isPending && event.target === event.currentTarget) event.currentTarget.close(); }}
    onKeyDown={event => {
      // The original native dialog needs two explicit tab stops while every
      // field is disabled: Chromium otherwise lets Tab leave for document.body.
      if (isPending && event.key === "Tab") {
        event.preventDefault();
        const submit = submitButtonRef.current;
        (document.activeElement === submit ? close.current : submit)?.focus();
      }
    }}>
    <div className="inquiry-dialog__head flex items-start justify-between gap-6 border-b border-border-subtle p-landing-concept-inquiry-header-inset landing-stack:p-landing-concept-inquiry-header-stacked-inset">
      <div><p className="inquiry-dialog__eyebrow m-0 mb-2 text-landing-concept-inquiry-eyebrow font-[850] text-brand-blue">KINDA / CONTACT</p><h2 ref={heading} id="concept-inquiry-title" tabIndex={-1} className="m-0 text-landing-concept-inquiry-title font-bold">{title}</h2><p id="concept-inquiry-description" className="m-landing-concept-inquiry-description-margin text-landing-concept-inquiry-description text-content-secondary">{description}</p></div>
      <Button ref={close} variant="landingConceptDismiss" type="button" aria-label="상담 팝업 닫기" aria-disabled={isPending} onClick={() => { if (!isPending) dialog.current?.close(); }}>✕</Button>
    </div>
    {children}
  </dialog>;
}
