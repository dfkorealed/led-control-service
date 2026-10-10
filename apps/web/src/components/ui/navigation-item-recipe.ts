import { cn } from "./utils/cn";

/** Shared by router links and button tabs; consumers keep navigation/ARIA ownership. */
export function navigationItemClass({ active, variant = "default" }: { active: boolean; variant?: "default" | "customer" }): string {
  return cn("inline-flex min-h-11 items-center justify-center gap-2 px-4 py-2 text-body font-semibold outline-none focus-visible:shadow-focus",
    variant === "customer"
      ? cn("rounded-control border border-transparent", active ? "bg-action-primary-soft text-action-primary" : "bg-transparent text-content-secondary hover:bg-surface-inset hover:text-content-primary")
      : cn("border-b-2", active ? "border-action-primary text-action-primary" : "border-transparent text-content-secondary"));
}
