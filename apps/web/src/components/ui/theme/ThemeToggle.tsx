import { IconButton } from "../IconButton";
import { Moon, Sun } from "lucide-react";
import { useCustomerTheme } from "./CustomerThemeProvider";
import { cn } from "../utils/cn";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useCustomerTheme();
  const dark = theme === "dark";
  // Rounded44px corners cannot supply a continuous44px pointer square. The
  // existing52px customer frame preserves that hit area without public changes.
  return <IconButton type="button" className={cn("size-13 shrink-0", className)} aria-label={dark ? "라이트 모드로 변경" : "다크 모드로 변경"} aria-pressed={dark} onClick={() => setTheme(dark ? "light" : "dark")}>
    {dark ? <Sun size={20} aria-hidden="true" /> : <Moon size={20} aria-hidden="true" />}
  </IconButton>;
}
