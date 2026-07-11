import { describe, expect, it } from "vitest";
import { createHardwareRequiredReport, probeLocalBluez, summarizeCapabilityReport } from "./bluez-capability";

describe("BlueZ capability report", () => {
  it("does not claim hardware validation outside Linux", () => {
    const report = createHardwareRequiredReport("darwin");

    expect(report.overall).toBe("hardware_required");
    expect(Object.values(report.checks).every((check) => check.status === "hardware_required")).toBe(true);
    expect(summarizeCapabilityReport(report)).toEqual({ exitCode: 2, passed: false });
  });

  it("requires every Phase 0 check before reporting passed", () => {
    const report = createHardwareRequiredReport("linux");
    report.overall = "incomplete";
    report.checks.daemon = { status: "passed", detail: "org.bluez.mesh available" };
    report.checks.adapter = { status: "passed", detail: "org.bluez.Adapter1 available" };

    expect(summarizeCapabilityReport(report)).toEqual({ exitCode: 3, passed: false });

    for (const key of Object.keys(report.checks) as Array<keyof typeof report.checks>) {
      report.checks[key] = { status: "passed", detail: `${key} verified` };
    }

    expect(summarizeCapabilityReport(report)).toEqual({ exitCode: 0, passed: true });
  });

  it("checks the mesh daemon and Bluetooth adapter without claiming RF validation", async () => {
    const calls: string[] = [];
    const caller = {
      call: async <T>(_service: string, _path: string, _interfaceName: string, method: string) => {
        calls.push(method);
        if (method === "NameHasOwner") return true as T;
        return { "/org/bluez/hci0": { "org.bluez.Adapter1": {} } } as T;
      }
    };

    const report = await probeLocalBluez(caller);

    expect(calls).toEqual(["NameHasOwner", "GetManagedObjects"]);
    expect(report.checks.daemon.status).toBe("passed");
    expect(report.checks.adapter.status).toBe("passed");
    expect(report.checks.scan.status).toBe("not_run");
    expect(report.overall).toBe("incomplete");
  });
});
