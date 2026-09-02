import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  isLoading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", isLoading = false, loadingLabel = "저장 중", children, className = "", disabled, ...props },
  ref
) {
  return <button ref={ref} {...props} disabled={disabled || isLoading} className={`ui-button ui-button-${variant} ${className}`.trim()}>{isLoading ? loadingLabel : children}</button>;
});
