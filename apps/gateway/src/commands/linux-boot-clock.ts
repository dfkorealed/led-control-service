import { readFileSync } from "node:fs";

export interface BootClockSample {
  bootId: string;
  milliseconds: number;
}

export class LinuxBootClock {
  constructor(private readonly options: {
    platform?: string;
    read?: (path: string) => string;
  } = {}) {}

  sample(): BootClockSample {
    if ((this.options.platform ?? process.platform) !== "linux") throw new Error("Linux boot clock unavailable");
    const read = this.options.read ?? ((path: string) => readFileSync(path, "utf8"));
    const bootId = read("/proc/sys/kernel/random/boot_id").trim();
    // Linux fs/proc/uptime.c uses ktime_get_boottime_ts64, including suspend.
    // DbClockProof applies its 100ms budget to expiry AND duration admission
    // limits because centisecond truncation can undercount elapsed time.
    // Target Pi clocksource/suspend/HIL certification is still a cutover prerequisite.
    const uptime = read("/proc/uptime").trim();
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(bootId) ||
        bootId !== read("/proc/sys/kernel/random/boot_id").trim() ||
        !/^\d+\.\d{2}\s+\d+(?:\.\d+)?$/.test(uptime)) {
      throw new Error("Invalid Linux boot clock sample");
    }
    const milliseconds = Math.round(Number(uptime.split(/\s/)[0]) * 1000);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error("Invalid Linux boot elapsed time");
    return { bootId, milliseconds };
  }
}
