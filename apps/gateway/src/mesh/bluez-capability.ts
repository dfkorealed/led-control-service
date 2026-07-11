export type CapabilityStatus = "passed" | "failed" | "hardware_required" | "not_run";
export type CapabilityName = "daemon" | "adapter" | "scan" | "provision" | "modelRoundTrip" | "restartRecovery";

export interface CapabilityCheck {
  status: CapabilityStatus;
  detail: string;
}

export interface BluezCapabilityReport {
  platform: string;
  checkedAt: string;
  overall: "passed" | "failed" | "incomplete" | "hardware_required";
  checks: Record<CapabilityName, CapabilityCheck>;
}

export interface BluezCaller {
  call<T>(service: string, path: string, interfaceName: string, method: string, args: unknown[]): Promise<T>;
}

const phase0Checks: CapabilityName[] = ["daemon", "adapter", "scan", "provision", "modelRoundTrip", "restartRecovery"];

export function createHardwareRequiredReport(platform: string): BluezCapabilityReport {
  const checks = Object.fromEntries(
    phase0Checks.map((name) => [name, { status: "hardware_required", detail: "Raspberry Pi와 ESP32-H2 실기 검증이 필요합니다." }])
  ) as Record<CapabilityName, CapabilityCheck>;

  return {
    platform,
    checkedAt: new Date().toISOString(),
    overall: platform === "linux" ? "incomplete" : "hardware_required",
    checks
  };
}

export async function probeLocalBluez(caller: BluezCaller): Promise<BluezCapabilityReport> {
  const report = createHardwareRequiredReport("linux");
  report.checks.scan = { status: "not_run", detail: "PB-ADV scan은 실기 체크리스트에서 실행합니다." };
  report.checks.provision = { status: "not_run", detail: "ESP32-H2 provisioning은 실기 체크리스트에서 실행합니다." };
  report.checks.modelRoundTrip = { status: "not_run", detail: "OnOff/Lightness 왕복은 실기 체크리스트에서 실행합니다." };
  report.checks.restartRecovery = { status: "not_run", detail: "재부팅 복구는 실기 체크리스트에서 실행합니다." };

  try {
    const daemonAvailable = await caller.call<boolean>(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "NameHasOwner",
      ["org.bluez.mesh"]
    );
    report.checks.daemon = daemonAvailable
      ? { status: "passed", detail: "org.bluez.mesh D-Bus service가 실행 중입니다." }
      : { status: "failed", detail: "org.bluez.mesh D-Bus service가 없습니다." };

    const managedObjects = await caller.call<Record<string, Record<string, unknown>>>(
      "org.bluez",
      "/",
      "org.freedesktop.DBus.ObjectManager",
      "GetManagedObjects",
      []
    );
    const adapterAvailable = Object.values(managedObjects).some((interfaces) => "org.bluez.Adapter1" in interfaces);
    report.checks.adapter = adapterAvailable
      ? { status: "passed", detail: "org.bluez.Adapter1 Bluetooth adapter를 찾았습니다." }
      : { status: "failed", detail: "org.bluez.Adapter1 Bluetooth adapter를 찾지 못했습니다." };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "알 수 없는 D-Bus 오류";
    if (report.checks.daemon.status === "hardware_required") report.checks.daemon = { status: "failed", detail };
    if (report.checks.adapter.status === "hardware_required") report.checks.adapter = { status: "failed", detail };
  }

  report.overall = Object.values(report.checks).some((check) => check.status === "failed") ? "failed" : "incomplete";
  return report;
}

export function summarizeCapabilityReport(report: BluezCapabilityReport) {
  const passed = Object.values(report.checks).every((check) => check.status === "passed");
  if (passed) return { exitCode: 0, passed: true };
  if (report.overall === "hardware_required") return { exitCode: 2, passed: false };
  return { exitCode: 3, passed: false };
}
