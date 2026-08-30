import { stat as fsStat } from "node:fs/promises";

export const SYSTEMD_TIMESYNC_MARKER = "/run/systemd/timesync/synchronized";
export const MAX_WALL_CLOCK_ROLLBACK_MS = 5 * 60 * 1000;

export interface ClockTrustProvider {
  isTrusted(now: Date): Promise<boolean>;
}

interface MarkerStat {
  mtimeMs: number;
  isFile(): boolean;
}

interface ClockTrustDependencies {
  stat?: (path: string) => Promise<MarkerStat>;
}

export class SystemClockTrustProvider implements ClockTrustProvider {
  private lastTrustedWallMs: number | null = null;
  private lastMarkerMtimeMs: number | null = null;
  private markerRefreshFenceMs: number | null = null;
  private readonly stat: (path: string) => Promise<MarkerStat>;

  constructor(
    private readonly markerPath = SYSTEMD_TIMESYNC_MARKER,
    dependencies: ClockTrustDependencies = {}
  ) {
    this.stat = dependencies.stat ?? fsStat;
  }

  async isTrusted(now: Date): Promise<boolean> {
    const wallMs = now.getTime();
    if (!Number.isFinite(wallMs)) return false;

    const marker = await this.readMarker();
    if (!marker) return false;

    if (this.markerRefreshFenceMs !== null) {
      if (marker.mtimeMs <= this.markerRefreshFenceMs) return false;
      this.markerRefreshFenceMs = null;
      this.lastTrustedWallMs = wallMs;
      this.lastMarkerMtimeMs = marker.mtimeMs;
      return true;
    }

    if (
      this.lastTrustedWallMs !== null &&
      this.lastTrustedWallMs - wallMs >= MAX_WALL_CLOCK_ROLLBACK_MS
    ) {
      const previousMarker = this.lastMarkerMtimeMs ?? marker.mtimeMs;
      if (marker.mtimeMs <= previousMarker) {
        this.markerRefreshFenceMs = previousMarker;
        return false;
      }
    }

    this.lastTrustedWallMs = wallMs;
    this.lastMarkerMtimeMs = marker.mtimeMs;
    return true;
  }

  private async readMarker(): Promise<MarkerStat | null> {
    try {
      const marker = await this.stat(this.markerPath);
      return marker.isFile() ? marker : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }
}
