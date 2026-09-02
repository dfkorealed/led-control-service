import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  isLoading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}

export function Button({ variant = "secondary", isLoading = false, loadingLabel = "저장 중", children, className = "", disabled, ...props }: ButtonProps) {
  return <button {...props} disabled={disabled || isLoading} className={`ui-button ui-button-${variant} ${className}`.trim()}>{isLoading ? loadingLabel : children}</button>;
}
