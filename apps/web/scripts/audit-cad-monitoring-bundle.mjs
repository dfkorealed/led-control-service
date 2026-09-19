import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const assetsDirectory = path.resolve(import.meta.dirname, "../dist/assets");
const javascriptFiles = readdirSync(assetsDirectory).filter((name) => name.endsWith(".js"));
const floorSceneFile = javascriptFiles.find((name) => name.startsWith("FloorScene-"));
assert.ok(floorSceneFile, "FloorScene production chunk was not produced");
const runtimeFile = javascriptFiles.find((name) => name.startsWith("cad-scene-readonly-runtime-"));
assert.ok(runtimeFile, "CAD monitoring runtime must be emitted as a dedicated lazy chunk");

const rendererFile = javascriptFiles.find((name) =>
  readFileSync(path.join(assetsDirectory, name), "utf8")
    .includes("CAD scene WebGL renderer is already mounted")
);
assert.ok(rendererFile, "CAD renderer must be emitted as a dedicated lazy chunk");
assert.notEqual(runtimeFile, floorSceneFile, "FloorScene must not statically include the CAD runtime");
assert.notEqual(rendererFile, floorSceneFile, "FloorScene must not statically include the Pixi renderer");
assert.notEqual(rendererFile, runtimeFile, "CAD runtime must lazy-load the Pixi renderer");

const floorSceneSource = readFileSync(path.join(assetsDirectory, floorSceneFile), "utf8");
const runtimeSource = readFileSync(path.join(assetsDirectory, runtimeFile), "utf8");
assert.match(
  floorSceneSource,
  new RegExp(runtimeFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  "FloorScene must request the CAD monitoring runtime only through dynamic import"
);
assert.match(
  runtimeSource,
  new RegExp(rendererFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  "CAD monitoring runtime must request the Pixi renderer through dynamic import"
);

const floorSceneBytes = statSync(path.join(assetsDirectory, floorSceneFile)).size;
assert.ok(floorSceneBytes < 400_000, `FloorScene chunk still contains heavy CAD runtime (${floorSceneBytes} bytes)`);

console.log(
  `CAD monitoring bundle audit passed: ${floorSceneFile} -> ${runtimeFile} -> ${rendererFile}`,
);
