import type { ChangeEvent } from "react";

/** Bot trap kept off screen and out of keyboard navigation, while remaining in the form DOM. */
export function HoneypotField({ value, onChange }: { value: string; onChange(value: string): void }) {
  return <label className="sr-only" aria-hidden="true">website
    <input name="website" autoComplete="off" tabIndex={-1} value={value} onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)} />
  </label>;
}
