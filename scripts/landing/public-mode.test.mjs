import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as templates from './template.mjs';
import { runRelease } from './deploy.mjs';
const config = {accountId:'123456789012',region:'ap-northeast-2',stackName:'kinda-landing-mode',bucket:'kinda-landing-mode-123456789012',distributionId:'DIST1234'};
test('service preflight requires a configured API before any remote call', async () => {
  let calls = 0;
  await assert.rejects(runRelease({mode:'deploy',deployMode:'service',execute:true,release:'r1'},config,async()=>{calls++;return {};}), /API origin/);
  assert.equal(calls,0);
});
test('mode template preserves API errors and forwards cookies, authorization, query and all methods uncached', () => {
  assert.equal(typeof templates.createTemplate, 'function');
  const t = templates.createTemplate('service','r1');
  const d = t.Resources.LandingDistribution.Properties.DistributionConfig;
  assert.ok(d.CustomErrorResponses.some(e=>e.ErrorCode===403));
  assert.ok(d.CustomErrorResponses.every(e=>e.ErrorCachingMinTTL===0 && e.ResponseCode===undefined && e.ResponsePagePath===undefined));
  const api = d.CacheBehaviors.filter(b=>b.PathPattern.startsWith('/api'));
  assert.deepEqual(api.map(b=>b.PathPattern), ['/api','/api/*']);
  for (const behavior of api) {
    assert.deepEqual(behavior.AllowedMethods,['GET','HEAD','OPTIONS','PUT','PATCH','POST','DELETE']);
    assert.equal(behavior.CachePolicyId,'4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    assert.equal(behavior.OriginRequestPolicyId,'b689b0a8-53d0-40ab-baf2-68738e2966ac');
    assert.equal(behavior.FunctionAssociations,undefined);
  }
  assert.equal(d.Origins[1].CustomOriginConfig.OriginProtocolPolicy,'https-only');
  assert.equal(templates.createTemplate('landing','r2').Resources.LandingDistribution.Properties.DistributionConfig.Origins.length,1);
});
test('edge binds exact HTML release, gates mode assets and returns real 404 without remapping API failures', () => {
  assert.equal(typeof templates.createTemplate, 'function');
  for (const mode of ['landing','service']) {
    const t = templates.createTemplate(mode,'release-1');
    const handler = vm.runInNewContext(`${t.Resources.ViewerRequest.Properties.FunctionCode};handler`);
    const request = uri => handler({request:{uri}});
    assert.equal(request('/features').uri,'/published/release-1/index.html');
    assert.equal(request('/brand/kinda-mark.svg').uri,'/published/release-1/brand/kinda-mark.svg');
    assert.equal(request(`/assets/${mode}/app-abcd1234.js`).uri,`/assets/${mode}/app-abcd1234.js`);
    assert.equal(request(`/assets/${mode === 'service' ? 'landing' : 'service'}/app-abcd1234.js`).statusCode,404);
    for (const path of ['/published/release-1/index.html','/releases/release-1/manifest.json','/unknown','/concepts/field-day.html','/settings/nope']) assert.equal(request(path).statusCode,404,path);
    if (mode === 'service') assert.equal(request('/settings/floor-plans/floor-1/edit').uri,'/published/release-1/index.html');
    else { assert.equal(request('/login').statusCode,404); assert.equal(request('/api/auth/me').statusCode,404); }
  }
});

// Independent oracle: AWS Developer Guide, CachingDisabled, verified 2026-10-11.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-policy-caching-disabled
// Do not import the production constant here: a typo must fail this contract.
test('both modes use the documented AWS CachingDisabled ID for default HTML behavior', () => {
  for (const mode of ['landing', 'service']) {
    const behavior = templates.createTemplate(mode, 'r1').Resources.LandingDistribution.Properties.DistributionConfig.DefaultCacheBehavior;
    assert.equal(behavior.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
  }
});
