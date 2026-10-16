import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, chmod, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const audit = await import('./release-audit.mjs').catch(() => ({}));
const evidence = await import('./release-evidence.mjs').catch(() => ({}));
const release = await import('./release.mjs').catch(() => ({}));
const record = (name, version) => ({ name, version });
const lock = {
  lockfileVersion: '9.0',
  importers: { 'apps/web': { dependencies: { react: { version: '18.3.1' }, shared: { version: 'link:../../packages/shared' } }, devDependencies: { vite: { version: '6.4.3' } } }, 'packages/shared': { dependencies: { zod: { version: '4.0.0' } } }, '.': { devDependencies: { 'js-yaml': { version: '4.3.2' } } } },
  packages: { 'react@18.3.1': {}, 'vite@6.4.3': {}, 'zod@4.0.0': {}, 'js-yaml@4.3.2': {}, 'esbuild@0.25.0': {} },
  snapshots: { 'react@18.3.1': {}, 'vite@6.4.3': { dependencies: { esbuild: '0.25.0' } }, 'esbuild@0.25.0': {}, 'zod@4.0.0': {}, 'js-yaml@4.3.2': {} }
};
function report(name = 'vite', version = '6.4.3', range = '<6.4.4') {
  return { advisories: { a: { github_advisory_id: 'GHSA-test-test-test', module_name: name, title: 'test advisory', severity: 'high', vulnerable_versions: range, patched_versions: '>=6.4.4', findings: [{ version, paths: [`apps/mobile > ${name}@${version}`] }] } }, metadata: { dependencies: 5, vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } } };
}
test('scope includes web dev tools, workspace closure and named gate roots', () => {
  assert.equal(typeof audit.lockClosure, 'function');
  const scope = audit.lockClosure(lock);
  assert.deepEqual(scope.packages.map(p => `${p.name}@${p.version}`).sort(), ['esbuild@0.25.0','js-yaml@4.3.2','react@18.3.1','vite@6.4.3','zod@4.0.0']);
  assert.deepEqual(scope.importers.sort(), ['.','apps/web','packages/shared']);
  const invalid = structuredClone(lock); delete invalid.snapshots['esbuild@0.25.0'];
  assert.throws(() => audit.lockClosure(invalid), /snapshot/);
  invalid.importers['apps/web'].dependencies.shared.version = 'link:../../apps/mobile';
  assert.throws(() => audit.lockClosure(invalid), /workspace|importer/);
});
test('advisory matches exact vulnerable package version, never first path or name alone', () => {
  assert.equal(typeof audit.evaluateScopeAudit, 'function');
  const scope = audit.lockClosure(lock);
  assert.equal(audit.evaluateScopeAudit(report(), scope).blocked.length, 1);
  const excluded = audit.evaluateScopeAudit(report('node-forge','1.4.0','<=1.4.0'), scope);
  assert.equal(excluded.blocked.length, 0); assert.equal(excluded.excluded.length, 1);
  // Even a report that only lists another version must not hide a vulnerable scoped version.
  assert.equal(audit.evaluateScopeAudit(report('vite','5.4.21','<6.4.4'), scope).blocked.length, 1);
  assert.equal(audit.evaluateScopeAudit(report('vite','5.4.21','<6.4.3'), scope).blocked.length, 0);
  assert.throws(() => audit.evaluateScopeAudit(report('vite','6.4.3','not a range'), scope), /range/);
});
test('fresh audit collector rejects command errors, malformed reports and inconsistent exits', () => {
  assert.equal(typeof audit.parseAuditCollection, 'function');
  assert.ok(audit.parseAuditCollection({ status: 1, stdout: JSON.stringify(report()) }));
  for (const data of [{ status: 2, stdout: JSON.stringify(report()) }, { status: 1, stdout: 'not json' }, { status: 1, stdout: '{"error":{"code":"ERR"}}' }, { status: 0, stdout: JSON.stringify(report()) }, { status: 1, stdout: JSON.stringify({ advisories: {}, metadata: { dependencies: 1, vulnerabilities: { info:0,low:0,moderate:0,high:0,critical:0 } } }) }]) assert.throws(() => audit.parseAuditCollection(data));
  const bad = report(); bad.advisories.a.severity = 'unknown'; assert.throws(() => audit.parseAuditCollection({status:1,stdout:JSON.stringify(bad)}));
  const malformed = report(); malformed.advisories.a.findings[0].version='garbage';
  assert.throws(()=>audit.evaluateScopeAudit(malformed,audit.lockClosure(lock)),/version/);
});
test('installed tool closure requires real metadata identity and rejects mismatched versions', async () => {
  assert.equal(typeof audit.installedClosure,'function');
  const root=await mkdtemp(join(tmpdir(),'landing-tools-'));
  try {
    await mkdir(join(root,'apps/web/node_modules/react'),{recursive:true});
    await writeFile(join(root,'apps/web/node_modules/react/package.json'),JSON.stringify(record('react','18.3.1')));
    const scope={roots:[{importer:'apps/web',name:'react',version:'18.3.1'}],packages:[record('react','18.3.1')]};
    const actual=await audit.installedClosure(root,scope); assert.equal(actual.packages[0].name,'react'); assert.match(actual.packages[0].metadataSha256,/^[a-f0-9]{64}$/);
    await writeFile(join(root,'apps/web/node_modules/react/package.json'),JSON.stringify(record('react','19.0.0')));
    await assert.rejects(audit.installedClosure(root,scope),/closure/);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('real module package metadata resolves through pnpm symlinks and binds lock identity', async () => {
  assert.equal(typeof evidence.packageForModule, 'function');
  const root = await mkdtemp(join(tmpdir(), 'landing-package-'));
  try {
    const pkg = join(root,'node_modules/.pnpm/react@18.3.1/node_modules/react');
    await mkdir(pkg, {recursive:true}); await writeFile(join(pkg,'package.json'), JSON.stringify(record('react','18.3.1'))); await writeFile(join(pkg,'index.js'),'export default 1');
    await symlink('.pnpm/react@18.3.1/node_modules/react',join(root,'node_modules/react'));
    const actual = await evidence.packageForModule(join(root,'node_modules/react/index.js'),root);
    assert.equal(actual.name,'react'); assert.equal(actual.version,'18.3.1'); assert.match(actual.metadataSha256,/^[a-f0-9]{64}$/);
    const proxy=await evidence.packageForModule('\0'+join(root,'node_modules/react/index.js')+'?commonjs-proxy',root);
    assert.equal(proxy.name,'react');
    const esImport=await evidence.packageForModule('\0'+join(root,'node_modules/react/index.js')+'?commonjs-es-import',root);
    assert.equal(esImport.name,'react');
    await assert.rejects(evidence.packageForModule('/tmp/external.js',root),/module|outside/);
    await assert.rejects(evidence.packageForModule('\0unknown-helper',root),/module/);
    await writeFile(join(pkg,'package.json'), '{}'); await assert.rejects(evidence.packageForModule(join(pkg,'index.js'),root), /metadata/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('build evidence fails closed for service mode, stale source, metadata and artifact bytes', async () => {
  assert.equal(typeof evidence.verifyBuildEvidence, 'function');
  const rendererEntry='apps/web/src/features/landing/render-public.tsx';
  const base = { version:1, mode:'landing', sourceSha256:'a'.repeat(64), artifactSha256:'b'.repeat(64), packages:[{...record('react','18.3.1'),path:'node_modules/react',metadataSha256:'c'.repeat(64)}], modules:[{module:'node_modules/react/index.js',kind:'published',package:'react@18.3.1',emitted:true},{module:rendererEntry,kind:'source',package:null,emitted:false}],chunks:{'assets/landing/app-abcd1234.js':['node_modules/react/index.js']},prerender:{sha256:'d'.repeat(64),modules:[rendererEntry,'node_modules/react/index.js']} };
  const expected = { sourceSha256:base.sourceSha256, artifactSha256:base.artifactSha256, scope:{packages:[record('react','18.3.1')]} };
  evidence.verifyBuildEvidence(base,expected);
  for(const altered of [{...base,mode:'service'},{...base,version:2},{...base,sourceSha256:'c'.repeat(64)},{...base,artifactSha256:'c'.repeat(64)},{...base,packages:[record('react','19.0.0')]},{...base,packages:[]}]) assert.throws(()=>evidence.verifyBuildEvidence(altered,expected));
  for(const altered of [{...base,modules:[]},{...base,chunks:{}},{...base,packages:[{...base.packages[0],metadataSha256:'wrong'}]},{...base,chunks:{'assets/landing/app-abcd1234.js':['/tmp/external.js']}}]) assert.throws(()=>evidence.verifyBuildEvidence(altered,expected));
  for(const prerender of [undefined,{}, {...base.prerender,sha256:'wrong'}, {...base.prerender,modules:[]}, {...base.prerender,modules:['node_modules/react/index.js']}, {...base.prerender,modules:[rendererEntry,'/tmp/external.js']}, {...base.prerender,modules:[rendererEntry,rendererEntry]}]) assert.throws(()=>evidence.verifyBuildEvidence({...base,prerender},expected),/renderer/i);
  assert.throws(()=>evidence.verifyBuildEvidence(base,{...expected,prerender:{...base.prerender,sha256:'e'.repeat(64)}}),/renderer/i);
});
test('release commands require explicit landing and frozen fresh public build before browser', () => {
  assert.equal(typeof release.releaseSteps,'function');
  assert.throws(()=>release.releaseSteps('service'),/landing/); assert.throws(()=>release.releaseSteps(undefined),/landing/);
  const steps=release.releaseSteps('landing');
  assert.deepEqual(steps[0],['pnpm','install','--frozen-lockfile']);
  assert.ok(steps.some(step=>step.includes('build:public')));
  assert.ok(steps.some(step=>step.includes('tsconfig.public.json')));
  assert.ok(steps.some(step=>step.includes('playwright.landing-release.config.ts')));
});
test('browser gate rejects skipped, flaky, failed or missing Chromium coverage', () => {
  assert.equal(typeof release.validateBrowserReport,'function');
  const base={config:{projects:[{name:'chromium'}]},stats:{expected:12,unexpected:0,skipped:0,flaky:0}};
  release.validateBrowserReport(base);
  for(const stats of [{...base.stats,expected:0},{...base.stats,expected:6},{...base.stats,unexpected:1},{...base.stats,skipped:1},{...base.stats,flaky:1}]) assert.throws(()=>release.validateBrowserReport({...base,stats}));
  assert.throws(()=>release.validateBrowserReport({...base,config:{projects:[{name:'firefox'}]}}));
});
test('actual landing publication CLI rejects a missing proof before invoking AWS', async () => {
  const fixture=await realpath(await mkdtemp(join(tmpdir(),'landing-publication-')));
  const project=resolve(import.meta.dirname,'../..');
  try {
    for(const directory of ['scripts/landing','apps/web/scripts','bin']) await mkdir(join(fixture,directory),{recursive:true});
    for(const name of ['deploy.mjs','template.mjs','release.mjs','release-audit.mjs','release-evidence.mjs']) await writeFile(join(fixture,'scripts/landing',name),await readFile(join(project,'scripts/landing',name)));
    await writeFile(join(fixture,'scripts/production-audit-policy.mjs'),await readFile(join(project,'scripts/production-audit-policy.mjs')));
    for(const name of ['public-deploy-contract.mjs','static-landing-contract.mjs']) await writeFile(join(fixture,'apps/web/scripts',name),await readFile(join(project,'apps/web/scripts',name)));
    await writeFile(join(fixture,'apps/web/404.html'),await readFile(join(project,'apps/web/404.html')));
    await symlink(join(project,'node_modules'),join(fixture,'node_modules'), 'dir');
    await symlink(join(project,'apps/web/node_modules'),join(fixture,'apps/web/node_modules'),'dir');
    const config={accountId:'123456789012',region:'ap-southeast-2',stackName:'kinda-landing-test',bucket:'kinda-landing-test-123456789012',distributionId:'ABCDE12345'};
    await writeFile(join(fixture,'config.json'),JSON.stringify(config));
    for(const [name,script] of [['pnpm','#!/bin/sh\nexit 0\n'],['aws','#!/bin/sh\nprintf called >> "$AWS_CALL_LOG"\nexit 1\n']]) {await writeFile(join(fixture,'bin',name),script);await chmod(join(fixture,'bin',name),0o700);}
    const result=spawnSync(process.execPath,[join(fixture,'scripts/landing/deploy.mjs'),'deploy','--config',join(fixture,'config.json'),'--release','test','--execute'],{cwd:fixture,encoding:'utf8',env:{...process.env,WEB_DEPLOY_MODE:'landing',PATH:join(fixture,'bin')+':'+process.env.PATH,AWS_CALL_LOG:join(fixture,'aws.log')}});
    assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,/landing-release\/proof\.json/);
    await assert.rejects(readFile(join(fixture,'aws.log')),error=>error.code==='ENOENT');
  } finally {await rm(fixture,{recursive:true,force:true});}
});
