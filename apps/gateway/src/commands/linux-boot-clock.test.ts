import { describe, expect, it } from "vitest";
import { LinuxBootClock } from "./linux-boot-clock";

const bootId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("LinuxBootClock", () => {
  it("reads suspend-inclusive proc uptime without consulting wall time", () => {
    let uptime = "12.34 9.00\n";
    const clock = new LinuxBootClock({ platform: "linux", read: (path) => path.endsWith("boot_id") ? `${bootId}\n` : uptime });
    expect(clock.sample()).toEqual({ bootId, milliseconds: 12_340 });
    uptime = "3612.34 9.00\n";
    expect(clock.sample()).toEqual({ bootId, milliseconds: 3_612_340 });
  });

  it.each(["", "NaN 0", "-1.00 0", "Infinity 0", "1e3 0", "1.999 0", "900719925474099.00 0"])("rejects malformed or imprecise uptime %s", (uptime) => {
    const clock = new LinuxBootClock({ platform: "linux", read: (path) => path.endsWith("boot_id") ? bootId : uptime });
    expect(() => clock.sample()).toThrow();
  });

  it("does not substitute an unsupported platform or unreadable proc clock", () => {
    expect(() => new LinuxBootClock({ platform: "darwin" }).sample()).toThrow();
    expect(() => new LinuxBootClock({ platform: "linux", read: () => { throw new Error("EACCES"); } }).sample()).toThrow();
    expect(() => new LinuxBootClock({ platform: "linux", read: () => "not-a-boot-id" }).sample()).toThrow();
  });

  it("rejects boot identity changes during sampling", () => {
    let reads = 0;
    const clock = new LinuxBootClock({ platform: "linux", read: (path) => path.endsWith("boot_id") ? (++reads === 1 ? bootId : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb") : "1.00 0.00" });
    expect(() => clock.sample()).toThrow();
  });
});
