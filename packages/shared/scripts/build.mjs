import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  unlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = join(packageRoot, "dist");
const manifestPath = join(packageRoot, ".build-output-manifest.json");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "led-shared-build-"));
const cjsDirectory = join(temporaryDirectory, "cjs");
const esmDirectory = join(temporaryDirectory, "esm");
let temporaryOutputCounter = 0;

try {
  runTypeScriptBuild("tsconfig.json", cjsDirectory);
  runTypeScriptBuild("tsconfig.esm.json", esmDirectory);
  await assertGeneratedDirectory(cjsDirectory);
  await assertGeneratedDirectory(esmDirectory);
  await writeGeneratedMetadataFile(
    esmDirectory,
    "package.json",
    `${JSON.stringify({ type: "module" }, null, 2)}\n`
  );

  const cjsFiles = await listFiles(cjsDirectory);
  const esmFiles = await listFiles(esmDirectory);
  const generatedFiles = validateGeneratedPaths([
    ...cjsFiles,
    ...esmFiles.map((path) => posix.join("esm", path))
  ]).sort();
  const previousFiles = await readBuildManifest();

  // Only a previous successful build's manifest grants ownership; unknown dist files are preserved.
  await preflightOutputPaths([...new Set([...previousFiles, ...generatedFiles])]);
  await removeGeneratedFiles(previousFiles);
  await copyGeneratedFiles(cjsDirectory, "", cjsFiles);
  await copyGeneratedFiles(esmDirectory, "esm", esmFiles);
  await writeBuildManifest(generatedFiles);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function runTypeScriptBuild(project, outDirectory) {
  const result = spawnSync("tsc", ["--project", project, "--outDir", outDirectory], {
    cwd: packageRoot,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`TypeScript build failed for ${project}`);
  }
}

async function listFiles(directory, prefix = "") {
  const filesystemDirectory = prefix
    ? join(directory, ...prefix.split("/"))
    : directory;
  const entries = await readdir(filesystemDirectory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(directory, path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

async function readBuildManifest() {
  try {
    const manifestStats = await lstat(manifestPath);
    if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
      throw new Error("invalid shared build output manifest file");
    }

    const manifestHandle = await open(manifestPath, constants.O_RDONLY | noFollowFlag());
    let manifestText;
    try {
      const openedStats = await manifestHandle.stat();
      if (!openedStats.isFile()) {
        throw new Error("invalid shared build output manifest file");
      }
      manifestText = await manifestHandle.readFile("utf8");
    } finally {
      await manifestHandle.close();
    }

    const manifest = JSON.parse(manifestText);
    if (manifest.version !== 1 || !Array.isArray(manifest.files)) {
      throw new Error("invalid shared build output manifest");
    }
    return validateGeneratedPaths(manifest.files);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function preflightOutputPaths(files) {
  for (const path of validateGeneratedPaths(files)) {
    await inspectOutputFile(path);
  }
}

async function removeGeneratedFiles(files) {
  const parentDirectories = new Set();
  for (const path of validateGeneratedPaths(files)) {
    const inspected = await inspectOutputFile(path);
    if (inspected.stats) {
      // unlink never follows the final component; the parent chain was just revalidated.
      await unlink(inspected.outputPath);
    }

    const segments = path.split("/");
    for (let index = segments.length - 1; index > 0; index -= 1) {
      parentDirectories.add(segments.slice(0, index).join("/"));
    }
  }

  for (const directory of [...parentDirectories].sort(compareDeepestPathFirst)) {
    try {
      const inspected = await inspectOutputDirectory(directory);
      if (inspected.exists) {
        await rmdir(inspected.outputPath);
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error)
        || !["ENOENT", "ENOTEMPTY"].includes(error.code)) {
        throw error;
      }
    }
  }
}

async function copyGeneratedFiles(sourceDirectory, destinationPrefix, files) {
  for (const path of validateGeneratedPaths(files)) {
    const destinationPath = validateGeneratedPath(
      destinationPrefix ? posix.join(destinationPrefix, path) : path
    );
    const source = await readGeneratedFile(join(sourceDirectory, ...path.split("/")));
    await ensureSafeParentDirectories(destinationPath);
    await writeOutputFile(destinationPath, source);
  }
}

async function writeBuildManifest(files) {
  const validatedFiles = validateGeneratedPaths(files);
  const temporaryManifestPath = `${manifestPath}.${process.pid}.tmp`;
  let temporaryManifestCreated = false;
  try {
    const temporaryManifestHandle = await open(
      temporaryManifestPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600
    );
    temporaryManifestCreated = true;
    try {
      await temporaryManifestHandle.writeFile(
        `${JSON.stringify({ version: 1, files: validatedFiles }, null, 2)}\n`
      );
    } finally {
      await temporaryManifestHandle.close();
    }
    await rename(temporaryManifestPath, manifestPath);
    temporaryManifestCreated = false;
  } finally {
    if (temporaryManifestCreated) {
      await unlink(temporaryManifestPath).catch(() => undefined);
    }
  }
}

function resolveOutputPath(path) {
  const validatedPath = validateGeneratedPath(path);
  const outputPath = resolve(distDirectory, ...validatedPath.split("/"));
  if (outputPath !== distDirectory && !outputPath.startsWith(`${distDirectory}${sep}`)) {
    throw new Error(`shared build output escapes dist: ${path}`);
  }
  return outputPath;
}

function validateGeneratedPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new Error(`invalid shared build output path: ${String(path)}`);
  }

  // Compiler artifacts use POSIX logical paths. Normalizing Windows syntax here could
  // turn drive-relative, device, or alternate-data-stream paths into unsafe aliases.
  if (path.includes(":") || path.includes("\\")) {
    throw new Error(`invalid shared build output path: ${path}`);
  }

  if (posix.isAbsolute(path) || win32.isAbsolute(path)) {
    throw new Error(`invalid shared build output path: ${path}`);
  }

  const segments = path.split("/");
  if (segments.some((segment) =>
    segment.length === 0
    || segment === "."
    || segment === ".."
    || segment.endsWith(".")
    || segment.endsWith(" ")
  )) {
    throw new Error(`invalid shared build output path: ${path}`);
  }
  return path;
}

function validateGeneratedPaths(paths) {
  const validatedPaths = paths.map(validateGeneratedPath);
  if (new Set(validatedPaths).size !== validatedPaths.length) {
    throw new Error("invalid shared build output manifest: duplicate file path");
  }
  return validatedPaths;
}

async function inspectOutputFile(path) {
  const validatedPath = validateGeneratedPath(path);
  const segments = validatedPath.split("/");
  const parent = await inspectDirectoryChain(segments.slice(0, -1));
  const outputPath = resolveOutputPath(validatedPath);
  if (!parent.exists) {
    return { outputPath, stats: undefined };
  }

  const stats = await lstatIfExists(outputPath);
  if (stats?.isSymbolicLink()) {
    throw new Error(`shared build output target is a symlink: ${validatedPath}`);
  }
  if (stats?.isDirectory()) {
    throw new Error(`shared build output manifest contains a directory: ${validatedPath}`);
  }
  if (stats && !stats.isFile()) {
    throw new Error(`shared build output target is not a regular file: ${validatedPath}`);
  }
  return { outputPath, stats };
}

async function inspectOutputDirectory(path) {
  const validatedPath = validateGeneratedPath(path);
  const segments = validatedPath.split("/");
  const inspected = await inspectDirectoryChain(segments);
  return {
    outputPath: resolveOutputPath(validatedPath),
    exists: inspected.exists
  };
}

async function inspectDirectoryChain(segments) {
  const rootStats = await lstatIfExists(distDirectory);
  if (!rootStats) {
    return { exists: false };
  }
  assertRealDirectory(rootStats, "dist");

  let currentPath = distDirectory;
  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    const stats = await lstatIfExists(currentPath);
    if (!stats) {
      return { exists: false };
    }
    assertRealDirectory(stats, currentPath);
  }
  return { exists: true };
}

async function ensureSafeParentDirectories(path) {
  const validatedPath = validateGeneratedPath(path);
  const parentSegments = validatedPath.split("/").slice(0, -1);
  await ensureDistRoot();

  for (let index = 0; index < parentSegments.length; index += 1) {
    const existingParents = parentSegments.slice(0, index);
    const inspectedParents = await inspectDirectoryChain(existingParents);
    if (!inspectedParents.exists) {
      throw new Error(`shared build output parent changed during mkdir: ${validatedPath}`);
    }

    const directoryPath = join(distDirectory, ...parentSegments.slice(0, index + 1));
    const existingStats = await lstatIfExists(directoryPath);
    if (!existingStats) {
      try {
        await mkdir(directoryPath);
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
          throw error;
        }
      }
    }

    const createdStats = await lstatIfExists(directoryPath);
    if (!createdStats) {
      throw new Error(`shared build output parent disappeared during mkdir: ${validatedPath}`);
    }
    assertRealDirectory(createdStats, directoryPath);
  }
}

async function ensureDistRoot() {
  let stats = await lstatIfExists(distDirectory);
  if (!stats) {
    try {
      await mkdir(distDirectory);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    stats = await lstatIfExists(distDirectory);
  }
  if (!stats) {
    throw new Error("shared build dist root disappeared during mkdir");
  }
  assertRealDirectory(stats, "dist");
}

async function readGeneratedFile(path) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`shared build generated source is not a regular file: ${path}`);
  }

  const sourceHandle = await open(path, constants.O_RDONLY | noFollowFlag());
  try {
    const openedStats = await sourceHandle.stat();
    if (!openedStats.isFile()) {
      throw new Error(`shared build generated source is not a regular file: ${path}`);
    }
    return await sourceHandle.readFile();
  } finally {
    await sourceHandle.close();
  }
}

async function assertGeneratedDirectory(directory) {
  const temporaryStats = await lstat(temporaryDirectory);
  if (temporaryStats.isSymbolicLink() || !temporaryStats.isDirectory()) {
    throw new Error("shared build temporary root is not a real directory");
  }

  const directoryStats = await lstat(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error(`shared build generated directory is not a real directory: ${directory}`);
  }
}

async function writeGeneratedMetadataFile(directory, filename, content) {
  await assertGeneratedDirectory(directory);
  const validatedFilename = validateGeneratedPath(filename);
  const path = join(directory, ...validatedFilename.split("/"));
  if (await lstatIfExists(path)) {
    throw new Error(`shared build generated metadata already exists: ${path}`);
  }

  const metadataHandle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
    0o666
  );
  try {
    await metadataHandle.writeFile(content);
  } finally {
    await metadataHandle.close();
  }
}

async function writeOutputFile(path, content) {
  const inspectedDestination = await inspectOutputFile(path);
  const temporaryPath = `${path}.led-build-${process.pid}-${temporaryOutputCounter += 1}.tmp`;
  const inspectedTemporary = await inspectOutputFile(temporaryPath);
  if (inspectedTemporary.stats) {
    throw new Error(`shared build temporary output already exists: ${temporaryPath}`);
  }

  let temporaryCreated = false;
  try {
    const temporaryHandle = await open(
      inspectedTemporary.outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o666
    );
    temporaryCreated = true;
    try {
      await temporaryHandle.writeFile(content);
    } finally {
      await temporaryHandle.close();
    }

    // Revalidate immediately before rename. rename replaces a final symlink instead of following it.
    await inspectOutputFile(path);
    await inspectOutputFile(temporaryPath);
    await rename(inspectedTemporary.outputPath, inspectedDestination.outputPath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) {
      await removeTemporaryOutput(temporaryPath);
    }
  }
}

async function removeTemporaryOutput(path) {
  try {
    const inspected = await inspectOutputFile(path);
    if (inspected.stats) {
      await unlink(inspected.outputPath);
    }
  } catch {
    // An unsafe parent is left untouched; a later clean build can reject it explicitly.
  }
}

async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function assertRealDirectory(stats, path) {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`shared build output parent is not a real directory: ${path}`);
  }
}

function noFollowFlag() {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("shared build requires O_NOFOLLOW support");
  }
  return constants.O_NOFOLLOW;
}

function compareDeepestPathFirst(left, right) {
  return right.split("/").length - left.split("/").length || right.localeCompare(left);
}
