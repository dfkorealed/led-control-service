import type { ReactNode } from "react";

/** Compensate for the fixed, wrapping public header without changing section or hash spacing. */
export function PublicInnerPage({ children }: { children: ReactNode }) {
  return <main className="pt-10 scroll-mt-landing-anchor-anchor-offset" id="main" tabIndex={-1}>{children}</main>;
}
