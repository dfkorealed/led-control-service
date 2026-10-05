import { useRef } from "react";
import { LogOut } from "lucide-react";
import { Button, Card, Heading, Text } from "../../components/ui";
import { useCustomerAccount } from "./CustomerAccountContext";

export function CustomerAccountPanel() {
  const { user, isLoggingOut, logoutError, requestLogout } = useCustomerAccount();
  const logoutRef = useRef<HTMLButtonElement>(null);
  return <Card aria-label="내 계정" className="grid min-w-0 gap-3 p-4">
    <Heading as="h2" variant="card-title">내 계정</Heading>
    <Text className="wrap-anywhere">{user.name} · {user.loginId}</Text>
    <Text variant="body-sm" tone="secondary">{user.role === "admin" ? "현장 관리자" : "일반 사용자"}</Text>
    <Button ref={logoutRef} type="button" variant="secondary" className="justify-self-start" isLoading={isLoggingOut} loadingLabel="로그아웃 중"
      onClick={() => requestLogout(logoutRef)}><LogOut size={18} aria-hidden="true" />로그아웃</Button>
    {logoutError ? <Text role="alert" tone="secondary">{logoutError}</Text> : null}
  </Card>;
}
