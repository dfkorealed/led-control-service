// Transpile only the child import closure; no shared build or API build output mutation.
const { readFileSync, mkdirSync, writeFileSync, existsSync, symlinkSync } = require("node:fs");
const { dirname, resolve, join } = require("node:path");
const ts = require("typescript");
const api = resolve(__dirname, "../..");
const output = resolve(api, "../../.superpowers/sdd/2026-09-18-cad-native-map-rendering/u4b-child-runtime");
const visited = new Set();
function emit(path) {
  if (visited.has(path)) return; visited.add(path);
  const result = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true
  } }).outputText;
  const relative = path.slice(join(api, "src").length + 1).replace(/\.ts$/, ".js");
  const target = join(output, relative); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, result);
  for (const match of result.matchAll(/require\("(\.[^"]+)"\)/g)) {
    const dependency = resolve(dirname(path), `${match[1]}.ts`);
    if (!existsSync(dependency)) throw new Error(`missing child dependency ${dependency}`);
    emit(dependency);
  }
}
emit(join(api, "src/floor-import/cad-core-child.ts"));
if (!existsSync(join(output, "node_modules"))) symlinkSync(join(api, "node_modules"), join(output, "node_modules"), "dir");
console.log(`Transpiled ${visited.size} child-only modules: ${output}/floor-import/cad-core-child.js`);
