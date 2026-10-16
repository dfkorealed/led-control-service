import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readClosure, installedClosure, collectFreshAudit, evaluateScopeAudit, parseAuditCollection } from './release-audit.mjs';
import { sourceIdentity, artifactIdentity, verifyBuildEvidence, digest } from './release-evidence.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const fail=message=>{throw new Error(message);};
const publicTests=['PublicContact.test.tsx','FeaturesPage.content.test.tsx','LandingPage.content.test.tsx','public-service-url.test.ts'];
export function releaseSteps(mode) {
  if(mode !== 'landing') fail('Explicit landing mode required; service needs full Software CI');
  return [
    ['pnpm','install','--frozen-lockfile'],
    ['pnpm','--filter','@led-control/shared','build'],
    ['pnpm','--filter','@led-control/web','exec','tsc','--project','tsconfig.public.json'],
    ['pnpm','--filter','@led-control/web','exec','vitest','run','--config','vitest.public.config.ts','--reporter=json','--outputFile=.local/landing-release-unit.json'],
    ['node','--test','scripts/landing/release.test.mjs','apps/web/scripts/public-deploy-contract.test.mjs','apps/web/scripts/static-landing.test.mjs','apps/web/scripts/static-landing-boundary.test.mjs'],
    ['pnpm','--filter','@led-control/web','build:public'],
    ['pnpm','--filter','@led-control/web','exec','playwright','test','--config','playwright.landing-release.config.ts']
  ];
}
function gitHead(project) {
  const result=spawnSync('git',['rev-parse','HEAD'],{cwd:project,encoding:'utf8'});
  if(result.status !== 0 || !/^[a-f0-9]{40}$/.test(result.stdout.trim())) fail('Cannot determine reviewed Git source');
  return result.stdout.trim();
}
function execute(project,step) {
  console.log('Landing gate: '+step.join(' '));
  const command=step[0] === 'node' ? process.execPath : step[0];
  const result=spawnSync(command,step.slice(1),{cwd:project,stdio:'inherit',env:{...process.env,WEB_DEPLOY_MODE:'landing',VITE_LANDING_SERVICE_URL:''}});
  if(result.error || result.signal || result.status !== 0) fail(`Landing gate failed: ${step.join(' ')} (${result.error?.message ?? result.signal ?? result.status})`);
}
export function validateBrowserReport(report) {
  if(report?.stats?.expected !== 12 || report.stats.unexpected !== 0 || report.stats.skipped !== 0 || report.stats.flaky !== 0 || !report.config?.projects?.some(p=>p.name === 'chromium')) fail('Incomplete or failed Chromium landing coverage');
}
export function validateUnitReport(report) {
  if(report?.success !== true || report.numTotalTests < 1 || report.numPassedTests !== report.numTotalTests || report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0 || report.testResults?.length !== publicTests.length || publicTests.some(name=>!report.testResults.some(file=>file.name.endsWith('/'+name) && file.status === 'passed'))) fail('Incomplete or failed public unit coverage');
}
export async function runLandingRelease(project=root) {
  const steps=releaseSteps(process.env.WEB_DEPLOY_MODE);
  if(Number(process.versions.node.split('.')[0]) !== 22) fail('Landing gate requires Node 22');
  const pnpm=spawnSync('pnpm',['--version'],{encoding:'utf8'});
  if(pnpm.status !== 0 || pnpm.stdout.trim() !== '9.15.0') fail('Landing gate requires pnpm 9.15.0');
  const directory=resolve(project,'.local/landing-release');
  await mkdir(directory,{recursive:true});
  // Invalidate any old success before running the first check. A failed new run
  // cannot leave a previous proof usable for publication.
  await rm(resolve(directory,'proof.json'),{force:true});
  const source=await sourceIdentity(project), head=gitHead(project);
  for(const step of steps.slice(0,-1)) execute(project,step);
  const scope=await readClosure(project), installed=await installedClosure(project,scope);
  const artifact=await artifactIdentity(resolve(project,'apps/web/dist-public'));
  const build=JSON.parse(await readFile(resolve(project,'apps/web/.local/public-landing-packages.json'),'utf8'));
  verifyBuildEvidence(build,{sourceSha256:source.sha256,artifactSha256:artifact.sha256,scope});
  for(const pkg of build.packages) if(!installed.packages.some(p=>p.path===pkg.path && p.name===pkg.name && p.version===pkg.version && p.metadataSha256===pkg.metadataSha256)) fail('Published metadata does not match installed tool closure');
  const collection=collectFreshAudit(project), evaluation=evaluateScopeAudit(collection.report,scope);
  await writeFile(resolve(directory,'audit.json'),JSON.stringify({collection,evaluation,installed},null,2));
  console.log(JSON.stringify({scopeRoots:scope.roots,scopedPackages:scope.packages.length,installedPackages:installed.packages.length,wholeRepositoryCounts:evaluation.wholeRepositoryCounts,included:evaluation.included,excluded:evaluation.excluded,blocked:evaluation.blocked},null,2));
  if(evaluation.blocked.length) fail('Landing/toolchain security audit has affected packages');
  execute(project,steps.at(-1));
  const browser=JSON.parse(await readFile(resolve(project,'apps/web/.local/landing-release-browser.json'),'utf8'));
  const unit=JSON.parse(await readFile(resolve(project,'apps/web/.local/landing-release-unit.json'),'utf8'));
  validateBrowserReport(browser);validateUnitReport(unit);
  if((await sourceIdentity(project)).sha256 !== source.sha256 || gitHead(project) !== head) fail('Source changed while the gate ran');
  const files={build,collection,evaluation,installed,unit,browser};
  const proof={version:1,mode:'landing',gitHead:head,sourceSha256:source.sha256,artifactSha256:artifact.sha256,completedAt:new Date().toISOString(),node:process.version,pnpm:'9.15.0',steps,files,artifact:artifact.artifact};
  await writeFile(resolve(directory,'proof.json'),JSON.stringify(proof,null,2));
  console.log('Landing release PASS: '+head+' artifact='+artifact.sha256);
  return proof;
}
export async function verifyLandingRelease(project=root) {
  const proof=JSON.parse(await readFile(resolve(project,'.local/landing-release/proof.json'),'utf8'));
  if(proof?.version !== 1 || proof.mode !== 'landing' || proof.gitHead !== gitHead(project) || proof.pnpm !== '9.15.0' || !/^v22\./.test(proof.node ?? '') || JSON.stringify(proof.steps) !== JSON.stringify(releaseSteps('landing'))) fail('Missing or incompatible landing release proof');
  const source=await sourceIdentity(project), artifact=await artifactIdentity(resolve(project,'apps/web/dist-public')), scope=await readClosure(project);
  if(proof.sourceSha256 !== source.sha256 || proof.artifactSha256 !== artifact.sha256 || JSON.stringify(proof.artifact) !== JSON.stringify(artifact.artifact)) fail('Fresh build differs from tested landing artifact/source');
  const files=proof.files;
  verifyBuildEvidence(files.build,{sourceSha256:source.sha256,artifactSha256:artifact.sha256,scope});
  validateBrowserReport(files.browser);validateUnitReport(files.unit);
  parseAuditCollection({status:files.collection.status,stdout:JSON.stringify(files.collection.report)});
  const evaluation=evaluateScopeAudit(files.collection.report,scope);
  if(evaluation.blocked.length || JSON.stringify(evaluation) !== JSON.stringify(files.evaluation)) fail('Landing security proof does not match current closure');
  const age=Date.now()-Date.parse(files.collection.collectedAt);
  if(!Number.isFinite(age) || age<0 || age>24*60*60*1000) fail('Landing security audit is stale; rerun the release gate');
  if(!Array.isArray(files.collection.command) || JSON.stringify(files.collection.command) !== JSON.stringify(['pnpm','audit','--json','--audit-level=low'])) fail('Wrong audit source');
  const freshBuild=JSON.parse(await readFile(resolve(project,'apps/web/.local/public-landing-packages.json'),'utf8'));
  verifyBuildEvidence(freshBuild,{sourceSha256:source.sha256,artifactSha256:artifact.sha256,scope,prerender:files.build.prerender});
  const identity=p=>`${p.name}@${p.version}:${p.metadataSha256}`;
  if(JSON.stringify([...new Set(freshBuild.packages.map(identity))].sort()) !== JSON.stringify([...new Set(files.build.packages.map(identity))].sort())) fail('Fresh published package metadata differs from tested build');
  return {verified:true,gitHead:proof.gitHead,artifactSha256:proof.artifactSha256,proofSha256:digest(JSON.stringify(proof))};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try { if(process.argv.length !== 2) fail('No alternate inputs or skip flags accepted'); await runLandingRelease(); }
  catch(error) {console.error(error.message);process.exitCode=1;}
}
