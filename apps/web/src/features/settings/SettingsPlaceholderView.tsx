import { Navigate, useLocation } from "react-router-dom";
import type { AuthUser } from "../../api/auth";
import { settingsSectionsFor, type SettingsSection } from "./settings-sections";

interface SettingsPlaceholderViewProps {
  section: SettingsSection;
  userRole: AuthUser["role"];
}

export function SettingsPlaceholderView({ section, userRole }: SettingsPlaceholderViewProps) {
  const location = useLocation();
  const isAllowed = settingsSectionsFor(userRole).some((candidate) => candidate.path === section.path);

  if (!isAllowed) {
    return <Navigate to={`/settings${location.search}${location.hash}`} replace />;
  }

  return (
    <section className="settings-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">설정</span>
          <h2>{section.label}</h2>
        </div>
      </div>
      <div className="panel">이 설정 화면은 준비 중입니다.</div>
    </section>
  );
}
