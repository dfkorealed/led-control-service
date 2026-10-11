import { createHash } from 'node:crypto';
import { publicRoutes, brandAssets, assertLandingModules, assertLandingOutput } from './static-landing-contract.mjs';
export { brandAssets };
export const artifactName = 'deployment.json';
export function parseDeployMode(value) {
  if (value === undefined) return 'landing';
  if (value !== 'landing' && value !== 'service') throw new Error('WEB_DEPLOY_MODE must be landing or service');
  return value;
}
// This is the deployment allowlist, derived from CustomerShell and OperatorShell.
// Update it alongside real route additions: unknown routes must remain HTTP 404.
export const serviceRoutes = Object.freeze([
  ...publicRoutes, '/login', '/monitoring', '/control', '/statistics',
  '/statistics/overview', '/statistics/analysis', '/statistics/reports',
  '/settings', '/settings/site', '/settings/users', '/settings/registration',
  '/settings/floor-plans', '/settings/security', '/operator/site-admins',
  '/operator/sensor-profiles', '/operator/landing-inquiries', '/operator/security'
]);
export const floorEditorPattern = '^/settings/floor-plans/[A-Za-z0-9_-]+/edit$';
export function isPublicPage(path, mode) {
  parseDeployMode(mode);
  return (mode === 'service' ? serviceRoutes : publicRoutes).includes(path)
    || (mode === 'service' && new RegExp(floorEditorPattern).test(path));
}
export function isPublicAsset(path, mode) {
  return brandAssets.includes(path) || new RegExp(`^assets/${parseDeployMode(mode)}/[\\w.-]+-[\\w-]+\\.(?:js|css|svg|png|webp|jpg|jpeg|avif|woff2?|gif|ico)$`).test(path);
}
export function assertPublicModules(ids, root, mode) {
  if (mode === 'landing') return assertLandingModules(ids, root);
  const modules = [...ids].map(id => id.replaceAll('\\', '/').split('?')[0]);
  for (const id of modules) {
    if (/(?:\/concepts\/|(?:FieldDayConceptPage|ConceptSiteLayout)\.|\.(?:test|spec)\.[cm]?[jt]sx?$|\/src\/test\/)/.test(id)) throw new Error(`Forbidden public module: ${id}`);
  }
  if (!modules.includes(`${root}/src/service-main.tsx`)) throw new Error('Missing service entry');
  return modules.filter(id => id.startsWith(`${root}/src/`)).map(id => id.slice(root.length + 1));
}
export function assertPublicOutput(bundle, mode) {
  for (const name of Object.keys(bundle)) {
    if (!['index.html', '404.html'].includes(name) && !isPublicAsset(name, mode)) throw new Error(`Unapproved ${mode} artifact: ${name}`);
  }
  if (mode === 'landing') {
    // Keep the original content boundary; normalize the mode namespace for that validator.
    assertLandingOutput(Object.fromEntries(Object.entries(bundle).map(([name, value]) => [name.replace('assets/landing/', 'assets/'), value])));
  }
  for (const name of ['index.html', '404.html']) if (!bundle[name]) throw new Error(`Missing public artifact: ${name}`);
}
export function createArtifact(mode, files) {
  parseDeployMode(mode);
  return { version: 1, mode, files: Object.entries(files).sort(([a],[b]) => a.localeCompare(b)).map(([key, bytes]) => ({ key, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) };
}
export function verifyArtifact(artifact, mode, files) {
  if (artifact?.version !== 1 || artifact.mode !== parseDeployMode(mode)) throw new Error('Artifact deployment mode mismatch');
  const expected = createArtifact(mode, files);
  if (!Array.isArray(artifact.files) || JSON.stringify(artifact.files.map(f => f.key)) !== JSON.stringify(expected.files.map(f => f.key))) throw new Error('Artifact files mismatch');
  if (JSON.stringify(artifact.files) !== JSON.stringify(expected.files)) throw new Error('Artifact integrity mismatch');
}
