import { forwardRef, useContext, useImperativeHandle, useLayoutEffect, useRef, useState, type AriaAttributes, type KeyboardEvent, type KeyboardEventHandler, type MutableRefObject, type Ref } from "react";
import { DateInput, DateSegment, DateFieldStateContext, TimeFieldStateContext, type DateInputProps, type DatePickerProps, type DateSegmentProps } from "react-aria-components";
import type { CalendarDate } from "@internationalized/date";
import type { FieldVisualProps } from "../fields/field-types";
import type { DateSegmentDraft } from "./useDateDraft";

export interface FocusableFieldHandle {
  /** No-op when disabled or read-only: there is no editable segment in those states. */
  focus(): void;
  readonly element: HTMLElement | null;
}
export interface DateFieldOptions extends FieldVisualProps, AriaAttributes, Pick<DatePickerProps<CalendarDate>,
  "id" | "isDisabled" | "isReadOnly" | "isRequired" | "isInvalid" | "validationBehavior" | "name" | "autoFocus" |
  "aria-label" | "aria-labelledby" | "aria-describedby"> {}

export function useSegmentedField(ref: Ref<FocusableFieldHandle>, isDisabled?: boolean, isReadOnly?: boolean) {
  const element = useRef<HTMLDivElement>(null);
  const firstSegment = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    get element() { return element.current; },
    focus() { if (!isDisabled && !isReadOnly) firstSegment.current?.focus(); }
  }), [isDisabled, isReadOnly]);
  return { element, firstSegment };
}

export interface DateDraftBinding {
  draft: DateSegmentDraft;
  onDraftChange(draft: DateSegmentDraft): void;
  restoring: MutableRefObject<boolean>;
  valueKey: string;
  /** Range fields share a canonical null and may reset an untouched sibling. */
  preserveUnedited?: boolean;
  rangeEdit?: MutableRefObject<RangeDraftEdit>;
}
const dateParts = ["year", "month", "day"] as const;
/** Internal range ownership: a publication fence does not authorize hydration. */
export interface RangeDraftEdit {
  accepted: DateSegmentDraft;
  pending: { part: typeof dateParts[number]; baseline: number | null; event: Event; element: HTMLElement; lifetime: object; finished: boolean } | null;
  restoreRequested: boolean;
}
function equalDraft(a: DateSegmentDraft, b: DateSegmentDraft) {
  return dateParts.every(part => a[part] === b[part]);
}

function DraftBridge({ binding, blurRevision }: { binding: DateDraftBinding; blurRevision: number }) {
  const state = useContext(DateFieldStateContext);
  const target = useRef(binding.draft);
  const revision = useRef(blurRevision);
  const valueKey = useRef(binding.valueKey);
  const hydrating = useRef(true);
  const range = binding.rangeEdit?.current;
  if (range && !equalDraft(range.accepted, binding.draft)) {
    // Own publications synchronously update accepted before their controlled
    // echo. A different owner value supersedes any unfinished endpoint edit.
    range.accepted = binding.draft;
    range.pending = null;
    range.restoreRequested = true;
    binding.restoring.current = true;
  }
  if (!range && (!equalDraft(target.current, binding.draft) || revision.current !== blurRevision || valueKey.current !== binding.valueKey)) {
    target.current = binding.draft;
    revision.current = blurRevision;
    valueKey.current = binding.valueKey;
    hydrating.current = true;
    binding.restoring.current = true;
  }
  useLayoutEffect(() => {
    if (!state) return;
    // RAC prohibits public segment writes in these states. Keep the raw parent
    // draft authoritative and hydrate only after editing becomes permitted.
    if (state.isDisabled || state.isReadOnly) {
      if (range) { range.pending = null; range.restoreRequested = true; }
      hydrating.current = true;
      binding.restoring.current = true;
      return;
    }
    const readPart = (part: typeof dateParts[number]) => {
      const segment = state.segments.find(item => item.type === part);
      return segment?.isPlaceholder ? null : segment?.value ?? null;
    };
    const raw: DateSegmentDraft = { year: readPart("year"), month: readPart("month"), day: readPart("day") };
    if (range) {
      const pending = range.pending;
      // A nested focus/blur may commit while RAC's input handler is still on
      // the stack. Native text-input bubble or the supplied public key handler's
      // normal return requests the observation that can accept a result/no-op.
      if (pending && !pending.finished) return;
      if (pending) {
        range.pending = null;
        if (raw[pending.part] !== pending.baseline) {
          const next = { ...range.accepted, [pending.part]: raw[pending.part] };
          binding.onDraftChange(next);
          return;
        }
      }
      if (!equalDraft(raw, range.accepted)) {
        range.restoreRequested = true;
        binding.restoring.current = true;
      }
      if (range.restoreRequested) {
        const difference = dateParts.find(part => raw[part] !== range.accepted[part]);
        if (difference) {
          const value = range.accepted[difference];
          // Each public setter closes over this committed display snapshot.
          if (value === null) state.clearSegment(difference); else state.setSegment(difference, value);
          return;
        }
        range.restoreRequested = false;
      }
      binding.restoring.current = false;
      return;
    }
    if (hydrating.current) {
      const difference = dateParts.find(part => raw[part] !== binding.draft[part]);
      if (difference) {
        // Public setters capture this render's display value. Applying all three
        // in one effect would overwrite earlier segments with stale state.
        const value = binding.draft[difference];
        if (value === null) state.clearSegment(difference); else state.setSegment(difference, value);
        return;
      }
      hydrating.current = false;
      binding.restoring.current = false;
    } else if (!equalDraft(raw, binding.draft)) {
      target.current = raw; // This is our own edit, not an external reset.
      binding.onDraftChange(raw);
    }
  });
  return null;
}

const editableSegmentClass = "inline-flex min-h-13 min-w-13 items-center justify-center rounded-control tabular-nums text-content-primary outline-none focus:bg-action-primary-soft focus:shadow-focus data-disabled:opacity-60";
function RegisteredSegment({ segment, firstSegment, binding, blurRevision, handleKey }: { segment: DateSegmentProps["segment"]; firstSegment?: Ref<HTMLDivElement>; binding?: DateDraftBinding; blurRevision: number; handleKey(event: KeyboardEvent<HTMLSpanElement>, handler?: KeyboardEventHandler<HTMLSpanElement>): void }) {
  const dateState = useContext(DateFieldStateContext);
  const timeState = useContext(TimeFieldStateContext);
  // Derive registration from React Aria's locale segment order on every render.
  // A closure counter would lose the ref when DateInput rerenders independently.
  const firstType = (dateState ?? timeState)?.segments.find((item) => item.isEditable)?.type;
  const part = dateParts.find(item => item === segment.type);
  const presentRaw = binding && part && (dateState?.isDisabled || dateState?.isReadOnly);
  const raw = binding && part ? binding.draft[part] : null;
  return <>{binding && segment.type === firstType && <DraftBridge binding={binding} blurRevision={blurRevision} />}
    {/* Static text preserves partial/impossible raw values while RAC correctly
        refuses restoration. It stays inside the labelled/described DateInput
        group, includes the locale's part label for assistive technology, and
        has no editable DOM or handlers. Never fake an editable upstream state. */}
    {presentRaw ? <span data-type={segment.type} data-disabled={dateState?.isDisabled || undefined}
      data-readonly={dateState?.isReadOnly || undefined} data-invalid={dateState?.isInvalid || undefined}
      data-placeholder={raw === null || undefined} className={editableSegmentClass}>
      {raw !== null && <span className="sr-only">{segment.placeholder} </span>}{raw ?? segment.placeholder}
    </span> : <DateSegment segment={segment} ref={segment.type === firstType ? firstSegment : undefined}
      render={binding?.rangeEdit && part ? domProps => <span {...domProps} onKeyDown={event => handleKey(event, domProps.onKeyDown)} /> : undefined}
      className={segment.type === "literal" ? "text-content-primary" : editableSegmentClass} />}</>;
}
export const SegmentedInput = /* @__PURE__ */ forwardRef<HTMLDivElement, Omit<DateInputProps, "children"> & { firstSegment?: Ref<HTMLDivElement>; draftBinding?: DateDraftBinding }>(function SegmentedInput({ firstSegment, draftBinding, ...props }, ref) {
  const [blurRevision, setBlurRevision] = useState(0);
  const editSurface = useRef<HTMLDivElement>(null);
  const currentBinding = useRef(draftBinding);
  const lifetime = useRef<object>({});
  const mounted = useRef(false);
  currentBinding.current = draftBinding;
  const markEdit = (event: Event) => {
    const target = event.target;
    const binding = currentBinding.current;
    if (!binding?.rangeEdit || !(target instanceof HTMLElement) || target.getAttribute("contenteditable") !== "true") return;
    const part = target instanceof HTMLElement ? dateParts.find(part => part === target.dataset.type) : undefined;
    if (part) {
      const range = binding.rangeEdit.current;
      range.pending = { part, baseline: range.accepted[part], event, element: target, lifetime: lifetime.current, finished: false };
    }
  };
  const finishEdit = (event: Event) => {
    const pending = currentBinding.current?.rangeEdit?.current.pending;
    if (!mounted.current || !pending || pending.event !== event || pending.element !== event.target || pending.lifetime !== lifetime.current) return;
    pending.finished = true;
    // Even rejected input must have a committed observation after its target
    // handler. This is an event boundary, not a timeout/microtask assumption.
    setBlurRevision(current => current + 1);
  };
  const handleKey = (event: KeyboardEvent<HTMLSpanElement>, handler?: KeyboardEventHandler<HTMLSpanElement>) => {
    const owner = currentBinding.current?.rangeEdit;
    const pending = owner?.current.pending;
    const matching = pending && pending.event === event.nativeEvent && pending.element === event.currentTarget && pending.lifetime === lifetime.current;
    // Public render composition preserves the supplied handler/event exactly.
    // Unlike an ancestor bubble, its normal return is observable even when RAC
    // consumes propagation. A throw must not falsely settle the edit.
    handler?.(event);
    if (matching && mounted.current && owner === currentBinding.current?.rangeEdit && owner.current.pending === pending && pending.lifetime === lifetime.current) {
      finishEdit(event.nativeEvent);
    }
  };
  useLayoutEffect(() => {
    mounted.current = true;
    lifetime.current = {};
    const element = editSurface.current;
    // RAC consumes native beforeinput for text insertion (including mobile
    // keyboards/paste), so no input event need follow. Observe, never cancel it.
    const beforeInput = (event: Event) => markEdit(event);
    const input = (event: Event) => markEdit(event);
    const blur = (event: FocusEvent) => {
      const binding = currentBinding.current;
      if (binding?.preserveUnedited && !element?.contains(event.relatedTarget as Node | null)) {
        // Native blur precedes React's focusout-backed onBlurCapture. RAC can
        // normalize the previous impossible display after an input auto-advance
        // in that interval; protect the newly published raw range first.
        binding.restoring.current = true;
        if (binding.rangeEdit) binding.rangeEdit.current.restoreRequested = true;
        setBlurRevision(current => current + 1);
      }
    };
    element?.addEventListener("beforeinput", beforeInput, true);
    element?.addEventListener("beforeinput", finishEdit);
    element?.addEventListener("input", input, true);
    element?.addEventListener("input", finishEdit);
    element?.addEventListener("blur", blur, true);
    return () => {
      mounted.current = false;
      element?.removeEventListener("beforeinput", beforeInput, true);
      element?.removeEventListener("beforeinput", finishEdit);
      element?.removeEventListener("input", input, true);
      element?.removeEventListener("input", finishEdit);
      element?.removeEventListener("blur", blur, true);
      if (currentBinding.current?.rangeEdit) currentBinding.current.rangeEdit.current.pending = null;
    };
  }, []);
  // DateInput's public DOM props intentionally exclude capture handlers. A
  // box-less native ancestor owns capture; DateInput's public ref stays intact.
  return <div ref={editSurface} className="contents" onKeyDownCapture={event => {
    if (/^\d$/.test(event.key) || ["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete"].includes(event.key)) markEdit(event.nativeEvent);
  }} onBlurCapture={event => {
    if (draftBinding && !draftBinding.preserveUnedited && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
      // React Aria confirms/constrains invalid full dates on field blur. Preserve
      // the caller's raw draft and suppress that normalization without stopping
      // focus propagation or replacing/mutating the public DateField state.
      draftBinding.restoring.current = true;
      setBlurRevision(current => current + 1);
    }
  }}><DateInput {...props} ref={ref}>{(segment) => <RegisteredSegment segment={segment} firstSegment={firstSegment} binding={draftBinding} blurRevision={blurRevision} handleKey={handleKey} />}</DateInput></div>;
});
