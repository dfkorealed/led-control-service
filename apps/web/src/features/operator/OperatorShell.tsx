import { useState } from "react";
import { LogOut } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { logout, type AuthUser } from "../../api/auth";
import { SiteAdminManagementView } from "./site-admins/SiteAdminManagementView";

export function OperatorShell({ user }: { user: AuthUser }) {
  const queryClient = useQueryClient();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  async function handleLogout() {
    if (isLoggingOut) return;
    setLogoutError("");
    setIsLoggingOut(true);
    try {
      await logout();
      queryClient.setQueryData(["auth", "me"], null);
      queryClient.removeQueries({
        predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[0] !== "auth"
      });
    } catch {
      setIsLoggingOut(false);
      setLogoutError("로그아웃에 실패했습니다. 연결을 확인한 뒤 다시 시도하세요.");
    }
  }

  return (
    <div className="operator-shell">
      <header className="operator-header">
        <div className="brand operator-brand">
          <span className="brand-mark">LC</span>
          <div>
            <strong>LED Control</strong>
            <span>서비스 운영</span>
          </div>
        </div>
        <div className="operator-header-actions">
          <span className="operator-login-id">{user.loginId}</span>
          <button className="logout-button" onClick={handleLogout} disabled={isLoggingOut}>
            <LogOut size={16} />
            {isLoggingOut ? "로그아웃 중" : "로그아웃"}
          </button>
        </div>
      </header>
      <main className="operator-content">
        {logoutError ? <p className="danger-text" role="alert">{logoutError}</p> : null}
        <Routes>
          <Route path="/operator/site-admins" element={<SiteAdminManagementView />} />
          <Route path="*" element={<Navigate to="/operator/site-admins" replace />} />
        </Routes>
      </main>
    </div>
  );
}
