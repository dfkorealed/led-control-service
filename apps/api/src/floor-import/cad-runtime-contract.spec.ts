import { assertCadProductionRuntime } from "./cad-runtime-contract";

describe("CAD production runtime contract", () => {
  const env = {
    NODE_ENV: "production",
    NODE_OPTIONS: "--max-old-space-size=256",
    CAD_CORE_MAX_OLD_SPACE_MB: "384",
    CAD_IMPORT_MAX_CONCURRENT_JOBS: "1",
    CAD_IMPORT_TEMP_VOLUME_BYTES: "536870912"
  } as NodeJS.ProcessEnv;

  it("requires the exact API heap, child heap, concurrency and Linux cgroup memory limit", () => {
    expect(() => assertCadProductionRuntime(env, "linux", () => "1476395008\n")).not.toThrow();
    for (const [name, value] of [
      ["NODE_OPTIONS", "--max-old-space-size=512"],
      ["CAD_CORE_MAX_OLD_SPACE_MB", "512"],
      ["CAD_IMPORT_MAX_CONCURRENT_JOBS", "2"],
      ["CAD_IMPORT_TEMP_VOLUME_BYTES", "402653184"]
    ] as const) {
      expect(() => assertCadProductionRuntime({ ...env, [name]: value }, "linux", () => "1476395008\n"))
        .toThrow(/CAD production runtime/i);
    }
    expect(() => assertCadProductionRuntime(env, "linux", () => "max\n")).toThrow(/cgroup/i);
    expect(() => assertCadProductionRuntime(env, "linux", () => "805306368\n")).toThrow(/cgroup/i);
  });

  it("fails closed when a required Linux CI cgroup gate is requested on macOS", () => {
    expect(() => assertCadProductionRuntime({ ...env, CAD_CGROUP_REQUIRED: "1" }, "darwin", () => ""))
      .toThrow(/Linux cgroup/i);
  });
});
