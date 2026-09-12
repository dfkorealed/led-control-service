import { describe, expect, it } from "vitest";
import { LinuxUsbIdentityInspector, type UsbIdentityFs } from "./linux-usb-identity-inspector";

function filesystem(options: { vendor?: string; product?: string; count?: number; denied?: boolean; character?: boolean } = {}): UsbIdentityFs {
  const entries = Array.from({ length: options.count ?? 1 }, (_, index) => `1-${index + 1}`);
  return {
    stat: async () => ({ rdev: 48128, isCharacterDevice: () => options.character ?? true }),
    realpath: async (path) => {
      if (path !== "/sys/dev/char/188:0/device") throw new Error(`Unexpected path ${path}`);
      return "/sys/devices/platform/usb1/1-1/1-1:1.0/ttyUSB0";
    },
    readdir: async () => entries,
    readFile: async (path) => {
      if (options.denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
      if (path.includes("1-1:1.0") || !/\/1-\d+\/id(Vendor|Product)$/.test(path)) {
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      }
      return path.endsWith("idVendor") ? `${options.vendor ?? "1A86"}\n` : `${options.product ?? "5523"}\n`;
    }
  };
}

describe("LinuxUsbIdentityInspector", () => {
  it("resolves container device aliases through character major/minor and USB ancestors", async () => {
    await expect(new LinuxUsbIdentityInspector(filesystem()).inspect("/dev/bio-dongle")).resolves.toEqual({
      devicePath: "/dev/bio-dongle", vendorId: "1a86", productId: "5523"
    });
  });
  it.each([{ vendor: "ffff" }, { product: "7523" }, { count: 0 }, { count: 2 }, { character: false }])("fails closed for wrong or ambiguous device %j", async (options) => {
    await expect(new LinuxUsbIdentityInspector(filesystem(options)).inspect("/dev/bio-dongle")).rejects.toMatchObject({ code: "USB_IDENTITY" });
  });
  it("fails closed when sysfs is unreadable", async () => {
    await expect(new LinuxUsbIdentityInspector(filesystem({ denied: true })).inspect("/dev/bio-dongle")).rejects.toMatchObject({ code: "USB_IDENTITY" });
  });
});
