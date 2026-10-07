import { themeColorTokens, type ThemeColorToken } from "../utils/theme-color";
export type CustomerTheme = "light" | "dark";
export type ThemePalette = Readonly<Record<ThemeColorToken, string>>;
export const customerThemeStorageKey = "led-control.customer-theme.v1";
export function parseCustomerThemePreference(value: string | null): CustomerTheme { return value === "dark" ? "dark" : "light"; }

export function readThemePalette(): ThemePalette {
  const style = getComputedStyle(document.documentElement);
  return Object.freeze(Object.fromEntries(themeColorTokens.map(token => [token, style.getPropertyValue(`--color-${token}`).trim()])) as Record<ThemeColorToken, string>);
}
