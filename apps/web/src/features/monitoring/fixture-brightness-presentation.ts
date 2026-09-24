import type { DashboardFixture } from "../../api/queries";

type FixtureBrightnessSource = Pick<DashboardFixture, "brightness" | "status" | "statusReason" | "lastSeenAt">;

export function presentFixtureBrightness(fixture: FixtureBrightnessSource): { label: string; value: string; observedAt: string | null } {
  const historical = fixture.status === "offline" || fixture.statusReason === "fixture_stale" || fixture.statusReason === "gateway_offline" || fixture.statusReason === "provisioning_waiting_state";
  const observedAt = fixture.lastSeenAt && Number.isFinite(Date.parse(fixture.lastSeenAt)) ? fixture.lastSeenAt : null;
  return {
    label: historical ? "최근 확인 밝기" : "현재 밝기",
    value: observedAt ? `${fixture.brightness}%` : "확인 전",
    observedAt
  };
}
