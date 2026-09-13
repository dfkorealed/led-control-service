const fs = require("node:fs");

// Docker Config.User만으로는 실제 process 권한을 증명하지 못한다. Linux가
// 보고하는 real/effective/saved/fs UID/GID와 모든 capability set을 검사한다.
// USB supplementary group 하나는 character device 접근에만 필요하며 추가
// group을 임의로 허용하지 않는다. GID0도 host가 실제 보고한 경우에만 허용한다.
function assertIsolatedProcess(status, usbGid) {
  if (!/^\d+$/.test(usbGid)) throw new Error("invalid group");
  const fields = new Map(status.split("\n").map(line => {
    const index = line.indexOf(":"); return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
  for (const name of ["Uid", "Gid"]) {
    const values = (fields.get(name) ?? "").split(/\s+/);
    if (values.length !== 4 || values.some(value => value !== "999")) throw new Error("unsafe identity");
  }
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    if (!/^0{16}$/.test(fields.get(name) ?? "")) throw new Error("unsafe capabilities");
  }
  const groups = (fields.get("Groups") ?? "").split(/\s+/);
  if (!groups.includes(usbGid) || groups.some(value => value !== usbGid && value !== "999") || fields.get("NoNewPrivs") !== "1") throw new Error("unsafe privilege boundary");
}

if (require.main === module) {
  try {
    const pids = fs.readdirSync("/proc").filter(value => /^\d+$/.test(value)).filter(pid => {
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
        return args.length === 2 && args[0] === "node" && args[1] === "/opt/led-control/gateway.mjs";
      } catch { return false; }
    });
    if (pids.length !== 1) throw new Error("runtime process unavailable");
    assertIsolatedProcess(fs.readFileSync(`/proc/${pids[0]}/status`, "utf8"), process.env.GATEWAY_BIO_USB_GID ?? "");
    process.stdout.write("BIO_RUNTIME_PROCESS_ISOLATED\n");
  } catch {
    process.stderr.write("BIO_RUNTIME_PROCESS_UNSAFE\n"); process.exitCode = 1;
  }
}
module.exports = { assertIsolatedProcess };
