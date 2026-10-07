import { IconButton } from "../IconButton";
import { Moon, Sun } from "lucide-react";
import { useCustomerTheme } from "./CustomerThemeProvider";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useCustomerTheme();
  const dark = theme === "dark";
  return <IconButton type="button" className={className} aria-label={dark ? "라이트 모드로 변경" : "다크 모드로 변경"} aria-pressed={dark} onClick={() => setTheme(dark ? "light" : "dark")}>
    {dark ? <Sun size={20} aria-hidden="true" /> : <Moon size={20} aria-hidden="true" />}
  </IconButton>;
}
