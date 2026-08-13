import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const noFollow = constants.O_NOFOLLOW ?? 0;

function fail(message) {
  process.stderr.write(`[lab-pki-files] ${message}\n`);
  process.exit(1);
}

function inside(root, path) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) fail("Lab PKI 경로가 신뢰 경계를 벗어났습니다.");
}

function assertNoSymlinkComponents(root, path) {
  inside(root, path);
  let current = resolve(path);
  const boundary = resolve(root);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail(`symlink 경로는 허용하지 않습니다: ${current}`);
    if (current === boundary) return;
    current = dirname(current);
  }
}

function openRegularNoFollow(path, flags, mode) {
  let descriptor;
  try {
    descriptor = openSync(path, flags | noFollow, mode);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`일반 파일이어야 합니다: ${path}`);
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error?.code === "ELOOP") fail(`symlink 파일은 허용하지 않습니다: ${path}`);
    throw error;
  }
}

function serialCopy(root, serialPath, temporaryPath) {
  assertNoSymlinkComponents(root, dirname(serialPath));
  assertNoSymlinkComponents(root, dirname(temporaryPath));
  let value = "1000\n";
  if (existsSync(serialPath)) {
    const descriptor = openRegularNoFollow(serialPath, constants.O_RDONLY);
    try {
      value = readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
  }
  if (!/^[0-9A-F]+\n$/i.test(value)) fail("Lab Root serial 형식이 올바르지 않습니다.");
  const descriptor = openRegularNoFollow(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(descriptor, value, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function serialCommit(root, serialPath, temporaryPath) {
  assertNoSymlinkComponents(root, dirname(serialPath));
  assertNoSymlinkComponents(root, dirname(temporaryPath));
  const descriptor = openRegularNoFollow(temporaryPath, constants.O_RDONLY);
  let value;
  try {
    value = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  if (!/^[0-9A-F]+\n$/i.test(value)) fail("OpenSSL이 생성한 serial 형식이 올바르지 않습니다.");
  const replacement = `${serialPath}.new-${process.pid}-${Date.now()}`;
  const replacementDescriptor = openRegularNoFollow(replacement, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(replacementDescriptor, value, "utf8");
  } finally {
    closeSync(replacementDescriptor);
  }
  try {
    if (existsSync(serialPath)) {
      const existing = openRegularNoFollow(serialPath, constants.O_RDONLY);
      closeSync(existing);
    }
    renameSync(replacement, serialPath);
  } finally {
    if (existsSync(replacement)) unlinkSync(replacement);
  }
}

function preflight(root, ...paths) {
  assertNoSymlinkComponents(root, root);
  for (const path of paths) {
    assertNoSymlinkComponents(root, dirname(path));
    if (existsSync(path)) {
      const descriptor = openRegularNoFollow(path, constants.O_RDONLY);
      closeSync(descriptor);
    }
  }
}

const [command, root, ...argumentsList] = process.argv.slice(2);
if (!command || !root) fail("usage: lab-pki-files.mjs preflight|serial-copy|serial-commit <root> ...");
try {
  if (command === "preflight") preflight(root, ...argumentsList);
  else if (command === "serial-copy" && argumentsList.length === 2) serialCopy(root, argumentsList[0], argumentsList[1]);
  else if (command === "serial-commit" && argumentsList.length === 2) serialCommit(root, argumentsList[0], argumentsList[1]);
  else fail("invalid command");
} catch (error) {
  fail(error?.message || "Lab PKI file operation failed");
}
