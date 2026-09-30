import type { FixtureMapPosition } from "../floor-map/fixture-map-position";
export type MonitoringFixtureFilter = "all" | "online" | "fault" | "offline" | "unplaced";
export function matchesMonitoringFixtureSearch(fixture: { name: string }, normalizedSearch: string): boolean {
  return !normalizedSearch || fixture.name.toLocaleLowerCase("ko-KR").includes(normalizedSearch);
}
export function matchesMonitoringFixture(fixture: { status: "online" | "fault" | "offline" }, filter: MonitoringFixtureFilter, position: FixtureMapPosition): boolean {
  if (filter === "all") return true;
  if (filter === "unplaced") return position.kind === "unplaced";
  return fixture.status === filter;
}
