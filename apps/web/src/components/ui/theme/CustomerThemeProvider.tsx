import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { customerThemeStorageKey, parseCustomerThemePreference, readThemePalette, type CustomerTheme, type ThemePalette } from "./customer-theme";

interface CustomerThemeState {
  theme: CustomerTheme;
  setTheme(theme: CustomerTheme): void;
  palette: ThemePalette;
  persistence: "available" | "unavailable";
}
export const CustomerThemeContext = createContext<CustomerThemeState | null>(null);
interface RootOwnership {
  previous: string | null;
  previousOwner?: RootOwnership;
  alive: boolean;
  value: CustomerTheme | null;
}
const rootOwners = new WeakMap<HTMLElement, RootOwnership>();

export function CustomerThemeProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(() => {
    try { return { theme: parseCustomerThemePreference(localStorage.getItem(customerThemeStorageKey)), persistence: "available" as const }; }
    catch { return { theme: "light" as const, persistence: "unavailable" as const }; }
  });
  const [theme, updateTheme] = useState<CustomerTheme>(initial.theme);
  const [persistence, setPersistence] = useState<CustomerThemeState["persistence"]>(initial.persistence);
  const [palette, setPalette] = useState(readThemePalette);
  const owner = useRef<RootOwnership | null>(null);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const claim: RootOwnership = { previous: root.getAttribute("data-customer-theme"), previousOwner: rootOwners.get(root), alive: true, value: null };
    owner.current = claim;
    rootOwners.set(root, claim);
    return () => {
      // Do not clear another owner's changes or native attributes/styles.
      // color-scheme is owned by the approved CSS alias, not an inline write.
      claim.alive = false;
      if (rootOwners.get(root) !== claim) return;
      let previous = claim.previous;
      let previousOwner = claim.previousOwner;
      // A superseded customer's cleanup may run before the current boundary
      // leaves. Skip released claims instead of restoring their stale theme.
      while (previousOwner && !previousOwner.alive) {
        previous = previousOwner.previous;
        previousOwner = previousOwner.previousOwner;
      }
      if (root.getAttribute("data-customer-theme") === claim.value) {
        const restore = previousOwner?.value ?? previous;
        if (restore === null) root.removeAttribute("data-customer-theme");
        else root.setAttribute("data-customer-theme", restore);
      }
      if (previousOwner) rootOwners.set(root, previousOwner);
      else rootOwners.delete(root);
    };
  }, []);

  useLayoutEffect(() => {
    if (!owner.current) return;
    owner.current.value = theme;
    if (rootOwners.get(document.documentElement) !== owner.current) return;
    document.documentElement.setAttribute("data-customer-theme", theme);
    // Publish only after the root alias is live. Layout updates flush before
    // paint without putting theme into any route/query/editor/command key.
    setPalette(readThemePalette());
  }, [theme]);

  const setTheme = useCallback((next: CustomerTheme) => {
    updateTheme(next);
    try { localStorage.setItem(customerThemeStorageKey, next); setPersistence("available"); }
    catch { setPersistence("unavailable"); }
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== customerThemeStorageKey && event.key !== null) return;
      if (event.storageArea !== null) {
        try { if (event.storageArea !== localStorage) return; }
        catch { setPersistence("unavailable"); return; }
      }
      updateTheme(parseCustomerThemePreference(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo(() => ({ theme, setTheme, palette, persistence }), [theme, setTheme, palette, persistence]);
  return <CustomerThemeContext.Provider value={value}>{children}</CustomerThemeContext.Provider>;
}

export function useCustomerTheme(): CustomerThemeState {
  const context = useContext(CustomerThemeContext);
  if (!context) throw new Error("useCustomerTheme requires CustomerThemeProvider");
  return context;
}
