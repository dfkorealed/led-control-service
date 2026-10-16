import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, realpath, readdir, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { verifyArtifact } from '../../apps/web/scripts/public-deploy-contract.mjs';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const inside = (root, file) => { const rel = relative(root,file); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
const generated=new Set(['\0commonjsHelpers.js','\0vite/modulepreload-polyfill.js']);
function unwrapModule(id) {
  if(typeof id !== 'string' || !id) fail('Invalid module ID');
  if(generated.has(id)) return null;
  if(id.startsWith('\0')) {
    // Vite 6's CommonJS plugin also emits es-import wrappers. Every wrapper
    // still resolves the underlying real file and its published package metadata.
    if(!/^\0\/.*\?commonjs-(?:proxy|exports|module|es-import)$/.test(id)) fail(`Unknown virtual module ${id}`);
    return id.slice(1).split('?')[0];
  }
  if(!isAbsolute(id)) fail(`Unknown relative module ${id}`);
  return id.split('?')[0];
}
function logicalModule(id,root) {
  const clean=unwrapModule(id);
  return clean===null ? id : (id.startsWith('\0')?'\0':'')+relative(root,clean)+(id.includes('?')?'?'+id.split('?').slice(1).join('?'):'');
}
export async function sourceIdentity(root) {
  const files = spawnSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'});
  if(files.status !== 0 || files.error) fail('Cannot bind landing source');
  const names = [...new Set(files.stdout.split('\0').filter(name => /^(?:apps\/web\/|packages\/shared\/|scripts\/landing\/|\.github\/workflows\/landing-release\.yml$|scripts\/production-audit-policy\.mjs$|(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.pnpmfile\.cjs)$)/.test(name)))].sort();
  const hashes = [];
  for(const name of names) {
    const file=resolve(root,name);
    if(!(await lstat(file)).isFile()) fail(`Non-file source ${name}`);
    hashes.push({name,sha256:digest(await readFile(file))});
  }
  if(!names.includes('pnpm-lock.yaml') || !names.includes('apps/web/vite.public.config.ts')) fail('Missing release source roots');
  return { sha256:digest(JSON.stringify(hashes)), files:hashes };
}
export async function packageForModule(id, root) {
  const clean = unwrapModule(id);
  if(clean===null) return null;
  const project=await realpath(root);
  if(!inside(project,clean) && !inside(resolve(root),clean)) fail('Module resolves outside frozen checkout');
  const file=await realpath(clean);
  if(!inside(project,file)) fail('Module resolves outside frozen checkout');
  if(!file.includes('/node_modules/')) {
    const local=relative(project,file);
    if(!/^apps\/web\/(?:src\/|landing\.html$|404\.html$)/.test(local)) fail(`Unknown local module ${local}`);
    return null;
  }
  let current=dirname(file);
  while(inside(project,current)) {
    let bytes;
    try { bytes=await readFile(resolve(current,'package.json')); } catch(error) { if(error.code !== 'ENOENT') throw error; }
    if(bytes) {
      const metadata=JSON.parse(bytes);
      if(typeof metadata.name !== 'string' || !metadata.name || typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(metadata.version)) fail(`Invalid module package metadata ${current}`);
      return {name:metadata.name,version:metadata.version,path:relative(project,current),metadataSha256:digest(bytes)};
    }
    current=dirname(current);
  }
  fail(`Unknown published module identity ${id}`);
}
export async function artifactIdentity(directory) {
  const bytes=await readFile(resolve(directory,'deployment.json'));
  const artifact=JSON.parse(bytes), files={};
  async function walk(prefix='') {
    for(const item of await readdir(resolve(directory,prefix),{withFileTypes:true})) {
      const key=prefix ? `${prefix}/${item.name}` : item.name;
      if(item.isSymbolicLink()) fail('Symlink in public artifact');
      if(item.isDirectory()) await walk(key);
      else if(item.isFile() && key !== 'deployment.json') files[key]=await readFile(resolve(directory,key));
      else if(!item.isFile()) fail('Non-file in public artifact');
    }
  }
  await walk(); verifyArtifact(artifact,'landing',files);
  return {sha256:digest(bytes),artifact};
}
export async function createBuildEvidence(root, rawModules, chunks, artifactSha256, prerender) {
  const raw=[...new Set(rawModules)].sort(), emitted=[...new Set(Object.values(chunks).flat())].sort();
  if(!raw.length || !emitted.length || emitted.some(id=>!raw.includes(id))) fail('Invalid Rollup module evidence');
  const mapping = [], packages = new Map();
  for(const id of raw) {
    const pkg=await packageForModule(id,root);
    const module=logicalModule(id,root);
    mapping.push({module,kind:pkg?'published':generated.has(id)?'generated':'source',package:pkg ? `${pkg.name}@${pkg.version}` : null,emitted:emitted.includes(id)});
    if(pkg) packages.set(pkg.path,pkg);
  }
  const source=await sourceIdentity(root);
  if (!prerender || !Array.isArray(prerender.modules)) fail('Missing renderer build evidence');
  return {version:1,mode:'landing',sourceSha256:source.sha256,artifactSha256,sourceFiles:source.files,packages:[...packages.values()].sort((a,b)=>a.path.localeCompare(b.path)),modules:mapping,chunks:Object.fromEntries(Object.entries(chunks).map(([key,ids])=>[key,ids.map(id=>logicalModule(id,root))])),prerender:{sha256:prerender.sha256,modules:prerender.modules.map(id=>logicalModule(id,root)).sort()}};
}
export function verifyBuildEvidence(evidence, expected) {
  if(evidence?.version !== 1 || evidence.mode !== 'landing' || !/^[a-f0-9]{64}$/.test(evidence.sourceSha256 ?? '') || evidence.sourceSha256 !== expected.sourceSha256 || evidence.artifactSha256 !== expected.artifactSha256) fail('Wrong mode or stale landing evidence');
  if(!Array.isArray(evidence.packages) || !evidence.packages.length) fail('Missing published package evidence');
  for(const pkg of evidence.packages) {
    if(!/^[a-f0-9]{64}$/.test(pkg.metadataSha256 ?? '') || typeof pkg.path !== 'string' || !pkg.path.includes('node_modules/') || pkg.path.includes('..') || isAbsolute(pkg.path)) fail('Malformed published package metadata');
    if(!expected.scope.packages.some(entry=>entry.name === pkg.name && entry.version === pkg.version)) fail(`Published package not in audited closure: ${pkg.name}@${pkg.version}`);
  }
  if(!Array.isArray(evidence.modules) || !evidence.modules.length || !evidence.chunks || Array.isArray(evidence.chunks) || !Object.keys(evidence.chunks).length) fail('Missing module graph evidence');
  const modules=new Map();
  for(const item of evidence.modules) {
    if(typeof item.module !== 'string' || modules.has(item.module) || typeof item.emitted !== 'boolean' || !['published','source','generated'].includes(item.kind)) fail('Malformed module graph');
    if(item.kind==='published' && (!evidence.packages.some(p=>item.package===`${p.name}@${p.version}`) || !/^\0?(?:node_modules|apps\/web\/node_modules)\//.test(item.module))) fail('Unknown published module');
    if(item.kind==='source' && (!/^apps\/web\/(?:src\/|landing\.html(?:\?|$)|404\.html(?:\?|$))/.test(item.module) || item.package!==null)) fail('Unknown source module');
    if(item.kind==='generated' && (!generated.has(item.module) || item.package!==null)) fail('Unknown generated module');
    modules.set(item.module,item);
  }
  const emitted=new Set();
  for(const [name,ids] of Object.entries(evidence.chunks)) {
    if(!/^assets\/landing\/[\w.-]+-[\w-]+\.js$/.test(name) || !Array.isArray(ids) || !ids.length) fail('Malformed emitted graph');
    for(const id of ids) { if(!modules.has(id)) fail('Emitted module absent from raw graph'); emitted.add(id); }
  }
  for(const item of modules.values()) if(item.emitted !== emitted.has(item.module)) fail('Raw/emitted module graph mismatch');
  // The build-only renderer is audited through the same raw package identities,
  // but its modules must not be mislabeled as emitted browser code.
  const renderer=evidence.prerender;
  if(!renderer || !/^[a-f0-9]{64}$/.test(renderer.sha256 ?? '') || !Array.isArray(renderer.modules) || !renderer.modules.includes('apps/web/src/features/landing/render-public.tsx') || new Set(renderer.modules).size !== renderer.modules.length || renderer.modules.some(id=>!modules.has(id))) fail('Missing or malformed renderer module evidence');
  if(expected.prerender && JSON.stringify(renderer) !== JSON.stringify(expected.prerender)) fail('Fresh renderer differs from tested build');
}
