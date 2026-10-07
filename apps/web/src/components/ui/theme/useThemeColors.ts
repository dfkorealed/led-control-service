import { useContext } from "react";
import { CustomerThemeContext } from "./CustomerThemeProvider";
import { readThemePalette, type ThemePalette } from "./customer-theme";
export function useThemeColors(): ThemePalette {
  return useContext(CustomerThemeContext)?.palette ?? readThemePalette();
}
