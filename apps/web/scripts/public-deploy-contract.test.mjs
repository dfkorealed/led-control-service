import test from 'node:test';
import assert from 'node:assert/strict';
const contract = await import('./public-deploy-contract.mjs').catch(() => ({}));
test('strict deployment mode defaults only when unset', () => {
  assert.equal(typeof contract.parseDeployMode, 'function');
  assert.equal(contract.parseDeployMode(undefined), 'landing');
  for (const mode of ['landing','service']) assert.equal(contract.parseDeployMode(mode), mode);
  for (const mode of ['', 'Service', 'service ', 'true', null]) assert.throws(() => contract.parseDeployMode(mode));
});
test('service exact routes cover shell nested routes but never arbitrary internal paths', () => {
  assert.equal(typeof contract.isPublicPage, 'function');
  for (const path of ['/','/features','/pricing']) assert.ok(contract.isPublicPage(path, 'landing'));
  for (const path of ['/login','/monitoring','/control','/statistics/analysis','/statistics/reports','/settings/users','/settings/floor-plans/abc-123/edit','/operator/site-admins','/operator/landing-inquiries']) {
    assert.ok(contract.isPublicPage(path, 'service'), path);
    assert.equal(contract.isPublicPage(path, 'landing'), false, path);
  }
  for (const path of ['/unknown','/api/auth/me','/concepts/field-day.html','/settings/nope','/features/','/settings/floor-plans/../edit','/operator/unknown']) assert.equal(contract.isPublicPage(path, 'service'), false, path);
});
test('artifact metadata binds mode to all emitted bytes and rejects stale metadata', () => {
  assert.equal(typeof contract.createArtifact, 'function');
  const files = {'index.html': Buffer.from('html'), '404.html': Buffer.from('404'), 'assets/service/app-abcd1234.js': Buffer.from('app')};
  const artifact = contract.createArtifact('service', files);
  contract.verifyArtifact(artifact, 'service', files);
  assert.throws(() => contract.verifyArtifact(artifact, 'landing', files), /mode/i);
  assert.throws(() => contract.verifyArtifact(artifact, 'service', {...files,'index.html':Buffer.from('changed')}), /integrity/i);
  assert.throws(() => contract.verifyArtifact(artifact, 'service', {...files,'secret.txt':Buffer.from('extra')}), /files/i);
});
test('public output permits only exact landing SEO files and requires all of them', () => {
  const files = Object.fromEntries(['index.html','404.html','features.html','pricing.html','robots.txt','sitemap.xml'].map(name=>[name,{type:'asset'}]));
  assert.doesNotThrow(()=>contract.assertPublicOutput(files,'landing'));
  for(const name of ['features.html','pricing.html','robots.txt','sitemap.xml']) {
    const missing = {...files};delete missing[name];assert.throws(()=>contract.assertPublicOutput(missing,'landing'),/Missing/);
  }
  for(const name of ['other.html','other.txt','other.xml','features/index.html','render-public.cjs']) assert.throws(()=>contract.assertPublicOutput({...files,[name]:{type:'asset'}},'landing'),/Unapproved/);
  for(const name of ['features.html','pricing.html','robots.txt','sitemap.xml']) assert.throws(()=>contract.assertPublicOutput({'index.html':{type:'asset'},'404.html':{type:'asset'},[name]:{type:'asset'}},'service'),/Unapproved/);
});
