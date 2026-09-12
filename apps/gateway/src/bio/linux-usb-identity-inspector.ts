import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { posix as path } from "node:path";
import { BioUsbError } from "./bio-usb-error";

export interface UsbIdentityFs {
  stat(path: string): Promise<{ rdev: number; isCharacterDevice(): boolean }>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
}
export interface BioUsbIdentity {
  devicePath: string;
  vendorId: string;
  productId: string;
}

export class LinuxUsbIdentityInspector {
  constructor(private readonly fs: UsbIdentityFs = { stat, realpath, readdir, readFile: (file) => readFile(file, "utf8") }) {}

  async inspect(devicePath: string): Promise<BioUsbIdentity> {
    try {
      const device = await this.fs.stat(devicePath);
      if (!device.isCharacterDevice()) throw new Error("Not a character device");
      // dev_t resolves both stable by-id links and container aliases without
      // assuming that the in-container filename is ttyUSB0.
      const id = BigInt(device.rdev);
      const major = ((id >> 8n) & 0xfffn) | ((id >> 32n) & 0xfffff000n);
      const minor = (id & 0xffn) | ((id >> 12n) & 0xffffff00n);
      let ancestor = await this.fs.realpath(`/sys/dev/char/${major}:${minor}/device`);
      let selected: { vendorId: string; productId: string } | undefined;
      while (ancestor.startsWith("/sys/")) {
        selected = await this.descriptor(ancestor);
        if (selected) break;
        ancestor = path.dirname(ancestor);
      }
      if (selected?.vendorId !== "1a86" || selected.productId !== "5523") throw new Error("Unexpected USB VID/PID");
      let count = 0;
      for (const entry of await this.fs.readdir("/sys/bus/usb/devices")) {
        const identity = await this.descriptor(path.join("/sys/bus/usb/devices", entry));
        if (identity?.vendorId === "1a86" && identity.productId === "5523") count++;
      }
      // This dongle has no serial number; selecting among multiple matches is unsafe.
      if (count !== 1) throw new Error("Expected exactly one BIO USB dongle");
      return { devicePath, ...selected };
    } catch (cause) {
      throw new BioUsbError("USB_IDENTITY", "BIO USB identity validation failed", { cause });
    }
  }

  private async descriptor(directory: string) {
    try {
      const vendorId = (await this.fs.readFile(path.join(directory, "idVendor"))).trim().toLowerCase();
      const productId = (await this.fs.readFile(path.join(directory, "idProduct"))).trim().toLowerCase();
      return { vendorId, productId };
    } catch (error) {
      // Interface and tty ancestors legitimately have no USB descriptor files.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
