import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { validateAuditReport } from '../production-audit-policy.mjs';
import { digest } from './release-evidence.mjs';

// Use the semver implementation actually installed for the public Babel toolchain;
// that package is also represented in the audited web lock closure.
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const babelRequire = createRequire(webRequire.resolve('@babel/core', { paths: [path.dirname(webRequire.resolve('@vitejs/plugin-react'))] }));
const semver = babelRequire('semver');
const fail = message => { throw new Error(message); };
export function lockClosure(lock) {
  if (String(lock?.lockfileVersion) !== '9.0' || !lock.importers || !lock.snapshots || !lock.packages) fail('Unknown landing lock schema');
  const snapshots = new Set(), importers = new Set(), roots = [];
  function importer(id, selected) {
    if (!lock.importers[id]) fail(`Unknown workspace importer ${id}`);
    const key = `${id}:${selected?.join(',') ?? '*'}`;
    if (importers.has(key)) return;
    importers.add(key);
    const item = lock.importers[id];
    for (const [name, value] of Object.entries({ ...item.dependencies, ...item.devDependencies, ...item.optionalDependencies })) {
      if (selected && !selected.includes(name)) continue;
      roots.push({ importer:id, name, version:value.version });
      edge(id, name, value.version);
    }
  }
  function edge(parent, name, version) {
    if (typeof version !== 'string') fail('Invalid lock dependency version');
    if (version.startsWith('link:')) {
      const id = path.posix.normalize(path.posix.join(parent, version.slice(5)));
      if (id !== 'packages/shared') fail(`Unapproved landing workspace ${id}`);
      // Shared runtime is consumed; its compiler is used by the gate. Its own
      // unrelated test tools are not run. All web dev tools remain in scope.
      const shared = lock.importers[id];
      return importer(id, [...Object.keys(shared?.dependencies ?? {}), ...Object.keys(shared?.optionalDependencies ?? {}), 'typescript']);
    }
    let key = `${name}@${version}`;
    if (!lock.snapshots[key] && lock.snapshots[version]) key = version; // npm alias keeps the real identity.
    if (snapshots.has(key)) return;
    if (!lock.snapshots[key]) fail(`Missing lock snapshot ${key}`);
    const match = key.match(/^(@[^/]+\/[^@]+|[^@]+)@([^()]+)/);
    if (!match || !semver.valid(match[2]) || !lock.packages[`${match[1]}@${match[2]}`]) fail(`Unknown lock package ${key}`);
    snapshots.add(key);
    const item = lock.snapshots[key];
    for (const [dependency, value] of Object.entries({ ...item.dependencies, ...item.optionalDependencies })) edge(parent, dependency, value);
  }
  importer('apps/web');
  importer('.', ['js-yaml','typescript']); // Gate parser and shared build compiler, including transitive closures.
  const packages = [...snapshots].sort().map(snapshot => {
    const [, name, version] = snapshot.match(/^(@[^/]+\/[^@]+|[^@]+)@([^()]+)/);
    return { name, version, snapshot };
  });
  return { roots, importers:[...new Set([...importers].map(id => id.split(':')[0]))].sort(), packages };
}
export async function readClosure(root) { return lockClosure(yaml.load(await readFile(path.join(root,'pnpm-lock.yaml'),'utf8'))); }
export async function installedClosure(root, scope) {
  root=await realpath(root);
  const packages=new Map(), optionalMissing=[];
  async function locate(base,name) {
    for(let current=base; current === root || current.startsWith(root+path.sep); current=path.dirname(current)) {
      const file=path.join(current,'node_modules',name,'package.json');
      try { return await realpath(file); } catch(error) { if(error.code !== 'ENOENT') throw error; }
      if(current === root) break;
    }
    return null;
  }
  async function visit(base,name,optional=false) {
    const file=await locate(base,name);
    if(!file) { if(optional) {optionalMissing.push({parent:path.relative(root,base),name});return;} fail(`Missing installed tool dependency ${name}`); }
    if(!file.startsWith(root+path.sep)) fail('Installed tool resolves outside checkout');
    if(packages.has(file)) return;
    const bytes=await readFile(file), metadata=JSON.parse(bytes);
    if(!scope.packages.some(p=>p.name === metadata.name && p.version === metadata.version)) fail(`Installed package outside audited closure: ${metadata.name}@${metadata.version}`);
    const pkg={name:metadata.name,version:metadata.version,path:path.relative(root,path.dirname(file)),metadataSha256:digest(bytes)};
    packages.set(file,pkg);
    const deps={...metadata.dependencies,...metadata.optionalDependencies,...metadata.peerDependencies};
    for(const dependency of Object.keys(deps)) await visit(path.dirname(file),dependency,Object.hasOwn(metadata.optionalDependencies ?? {},dependency) || metadata.peerDependenciesMeta?.[dependency]?.optional === true);
  }
  for(const entry of scope.roots) {
    if(entry.version.startsWith('link:')) continue; // Workspace runtime/compiler roots are separately enumerated.
    await visit(path.join(root,entry.importer),entry.name);
  }
  return {packages:[...packages.values()].sort((a,b)=>a.path.localeCompare(b.path)),optionalMissing};
}
export function parseAuditCollection(result) {
  if (result.error || result.signal || ![0,1].includes(result.status)) fail(`Audit collection failed: ${result.error?.message ?? result.signal ?? result.status}`);
  let report;
  try { report = JSON.parse(result.stdout); } catch { fail('Audit source returned non-JSON'); }
  validateAuditReport(report);
  const total = Object.values(report.metadata.vulnerabilities).reduce((sum, count) => sum + count, 0);
  if ((result.status === 0) !== (total === 0)) fail('Audit exit disagrees with findings');
  return report;
}
export function evaluateScopeAudit(report, scope) {
  validateAuditReport(report);
  const blocked = [], included = [], excluded = [];
  for (const advisory of Object.values(report.advisories)) {
    if (!semver.validRange(advisory.vulnerable_versions) || !semver.validRange(advisory.patched_versions)) fail('Invalid advisory version range');
    if(advisory.findings.some(finding=>!semver.valid(finding.version))) fail('Invalid advisory finding version');
    const affected = scope.packages.filter(p => p.name === advisory.module_name && semver.satisfies(p.version, advisory.vulnerable_versions, {includePrerelease:true}));
    const entry = { id:advisory.github_advisory_id, name:advisory.module_name, severity:advisory.severity, vulnerable:advisory.vulnerable_versions, patched:advisory.patched_versions, findings:advisory.findings, scopedVersions:[...new Set(affected.map(p=>p.version))] };
    if (!affected.length) excluded.push(entry);
    else {
      included.push(entry);
      // Match the unchanged production policy: Moderate+ blocks, Low/Info stay
      // visible in the collected report and included/excluded scope output.
      if (['moderate','high','critical'].includes(advisory.severity)) blocked.push(entry);
    }
  }
  return { included, excluded, blocked, wholeRepositoryCounts:report.metadata.vulnerabilities, scope };
}
export function collectFreshAudit(root) {
  // No --prod: public compiler, CSS, test and browser tool dependencies matter.
  const result = spawnSync('pnpm',['audit','--json','--audit-level=low'], {cwd:root, encoding:'utf8', maxBuffer:64*1024*1024});
  return { collectedAt:new Date().toISOString(), command:['pnpm','audit','--json','--audit-level=low'], status:result.status, stderr:result.stderr, report:parseAuditCollection(result) };
}
