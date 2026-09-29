import { CircleCheck, CircleX, Clock3, TriangleAlert } from "lucide-react";
import { StatusBadge } from "../../components/ui";
import type { DashboardFixture } from "../../api/queries";
import { presentFixtureStatus } from "./fixture-status-presentation";
export function FixtureStatusBadge({ fixture }: { fixture: DashboardFixture | null }) {
  const status = fixture ? presentFixtureStatus(fixture) : null;
  const icon = status?.tone === "success" ? CircleCheck : status?.tone === "danger" ? TriangleAlert : status?.tone === "warning" || !status ? Clock3 : CircleX;
  return <StatusBadge tone={status?.tone ?? "neutral"} icon={icon}>{status?.label ?? "조명 정보 확인 전"}</StatusBadge>;
}
