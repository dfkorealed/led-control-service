import { forwardRef } from "react";
import { Button, type ButtonProps } from "./Button";
import { cn } from "./utils/cn";

export interface IconButtonProps extends ButtonProps {
  "aria-label": string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, ...props }, ref
) {
  return <Button {...props} ref={ref} className={cn("aspect-square min-w-11 p-2", className)} />;
});
