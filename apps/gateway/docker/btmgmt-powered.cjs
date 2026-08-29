const controller = process.argv[2];

if (!/^hci\d+$/.test(controller ?? "")) process.exit(1);

let output = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { output += chunk; });
process.stdin.on("end", () => {
  const lines = output.split(/\r?\n/);
  const controllerHeader = new RegExp(`^\\s*${controller}:\\s+.+$`);
  const controllerIndex = lines.findIndex((line) => controllerHeader.test(line));
  if (controllerIndex < 0) process.exit(1);

  for (const line of lines.slice(controllerIndex + 1)) {
    const trimmed = line.trim();
    if (/^hci\d+:/.test(trimmed)) process.exit(1);
    const settings = /^current settings:\s+(.+)$/.exec(trimmed);
    if (settings) process.exit(settings[1].split(/\s+/).includes("powered") ? 0 : 1);
  }

  process.exit(1);
});
