import { useRef } from "react";
import { LogOut } from "lucide-react";
import { Button, Heading, Text } from "../../components/ui";
import { useCustomerAccount } from "./CustomerAccountContext";

export function CustomerAccountPanel() {
  const { user, isLoggingOut, logoutError, requestLogout } = useCustomerAccount();
  const logoutRef = useRef<HTMLButtonElement>(null);
  return <section aria-label="내 계정" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-default py-2">
    <Heading as="h2" variant="customer-card-title" className="sr-only">내 계정</Heading>
    <Text className="wrap-anywhere">{user.name} · {user.loginId}</Text>
    <Text variant="body-sm" tone="secondary">{user.role === "admin" ? "현장 관리자" : "일반 사용자"}</Text>
    <Button ref={logoutRef} type="button" variant="ghost" className="ml-auto" isLoading={isLoggingOut} loadingLabel="로그아웃 중"
      onClick={() => requestLogout(logoutRef)}><LogOut size={18} aria-hidden="true" />로그아웃</Button>
    {logoutError ? <Text role="alert" tone="secondary" className="w-full">{logoutError}</Text> : null}
  </section>;
}
