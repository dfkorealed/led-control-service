import { createContext, useContext, type RefObject } from "react";
import type { AuthUser } from "../../api/auth";

export interface CustomerAccountContextValue {
  user: AuthUser;
  isLoggingOut: boolean;
  logoutError: string | null;
  requestLogout(returnFocusRef: RefObject<HTMLButtonElement | null>): void;
}
export const CustomerAccountContext = createContext<CustomerAccountContextValue | null>(null);
export function useCustomerAccount(): CustomerAccountContextValue {
  const value = useContext(CustomerAccountContext);
  if (!value) throw new Error("Customer account requires the customer shell");
  return value;
}
