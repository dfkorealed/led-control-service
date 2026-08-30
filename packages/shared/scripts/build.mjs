import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = join(packageRoot, "dist");
const manifestPath = join(packageRoot, ".build-output-manifest.json");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "led-shared-build-"));
const cjsDirectory = join(temporaryDirectory, "cjs");
const esmDirectory = join(temporaryDirectory, "esm");

try {
  runTypeScriptBuild("tsconfig.json", cjsDirectory);
  runTypeScriptBuild("tsconfig.esm.json", esmDirectory);
  await writeFile(join(esmDirectory, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);

  const cjsFiles = await listFiles(cjsDirectory);
  const esmFiles = await listFiles(esmDirectory);
  const generatedFiles = [
    ...cjsFiles,
    ...esmFiles.map((path) => join("esm", path))
  ].sort();
  const previousFiles = await readBuildManifest();

  // Only a previous successful build's manifest grants ownership; unknown dist files are preserved.
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
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(prefix, entry.name);
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
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.version !== 1 || !Array.isArray(manifest.files)) {
      throw new Error("invalid shared build output manifest");
    }
    return manifest.files.map(validateGeneratedPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function removeGeneratedFiles(files) {
  const parentDirectories = new Set();
  for (const path of files) {
    const outputPath = resolveOutputPath(path);
    await rm(outputPath, { force: true });
    let parentDirectory = dirname(outputPath);
    while (parentDirectory !== distDirectory) {
      parentDirectories.add(parentDirectory);
      parentDirectory = dirname(parentDirectory);
    }
  }

  for (const directory of [...parentDirectories].sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error)
        || !["ENOENT", "ENOTEMPTY"].includes(error.code)) {
        throw error;
      }
    }
  }
}

async function copyGeneratedFiles(sourceDirectory, destinationPrefix, files) {
  for (const path of files) {
    const destinationPath = resolveOutputPath(join(destinationPrefix, path));
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(join(sourceDirectory, path), destinationPath);
  }
}

async function writeBuildManifest(files) {
  const temporaryManifestPath = `${manifestPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryManifestPath, `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
    await rename(temporaryManifestPath, manifestPath);
  } finally {
    await rm(temporaryManifestPath, { force: true });
  }
}

function resolveOutputPath(path) {
  const validatedPath = validateGeneratedPath(path);
  const outputPath = resolve(distDirectory, validatedPath);
  if (outputPath !== distDirectory && !outputPath.startsWith(`${distDirectory}${sep}`)) {
    throw new Error(`shared build output escapes dist: ${path}`);
  }
  return outputPath;
}

function validateGeneratedPath(path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) {
    throw new Error(`invalid shared build output path: ${String(path)}`);
  }
  const normalizedPath = normalize(path);
  if (normalizedPath === "." || normalizedPath === ".." || normalizedPath.startsWith(`..${sep}`)) {
    throw new Error(`invalid shared build output path: ${path}`);
  }
  return normalizedPath;
}
