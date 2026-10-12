import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseDeployMode, serviceRoutes, floorEditorPattern, brandAssets } from '../../apps/web/scripts/public-deploy-contract.mjs';
import { publicRoutes } from '../../apps/web/scripts/static-landing-contract.mjs';
// AWS managed CachingDisabled: verified against the Developer Guide.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-policy-caching-disabled
const cachingDisabledPolicyId = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ref = (name) => ({ Ref: name });
const attr = (name, key) => ({ 'Fn::GetAtt': [name, key] });
const sub = (value) => ({ 'Fn::Sub': value });
const choose = (yes, no) => ({ 'Fn::If': ['CustomDomain', yes, no] });
const cache = (name, ttl, max) => ({ Type: 'AWS::CloudFront::CachePolicy', Properties: { CachePolicyConfig: {
  Name: sub(`\${AWS::StackName}-${name}`), MinTTL: 0, DefaultTTL: ttl, MaxTTL: max,
  ParametersInCacheKeyAndForwardedToOrigin: { EnableAcceptEncodingGzip: true, EnableAcceptEncodingBrotli: true, CookiesConfig: { CookieBehavior: 'none' }, HeadersConfig: { HeaderBehavior: 'none' }, QueryStringsConfig: { QueryStringBehavior: 'none' } }
} } });
const behavior = (policy) => ({ TargetOriginId: 'private-landing', ViewerProtocolPolicy: 'redirect-to-https', AllowedMethods: ['GET','HEAD'], CachedMethods: ['GET','HEAD'], Compress: true, CachePolicyId: ref(policy), ResponseHeadersPolicyId: ref('SecurityHeaders'), FunctionAssociations: [{ EventType: 'viewer-request', FunctionARN: attr('ViewerRequest', 'FunctionARN') }] });
const baseTemplate = {
  AWSTemplateFormatVersion: '2010-09-09', Description: 'Dedicated Kinda public landing: private S3, CloudFront OAC, exact routes. Pay-as-you-go; no pricing plan subscription.',
  Parameters: {
    BucketName: { Type: 'String', AllowedPattern: '[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]' },
    DomainName: { Type: 'String', Default: '' },
    CertificateArn: { Type: 'String', Default: '', Description: 'Existing ISSUED ACM certificate in us-east-1; do not create or replace certificates.' },
    HostedZoneId: { Type: 'String', Default: '', Description: 'Existing public Route 53 zone for managed DNS; leave empty to manage the domain CNAME in an external DNS provider.' }
  },
  Conditions: {
    CustomDomain: { 'Fn::Not': [{ 'Fn::Equals': [ref('DomainName'), ''] }] },
    ManagedDns: { 'Fn::And': [
      { 'Fn::Not': [{ 'Fn::Equals': [ref('DomainName'), ''] }] },
      { 'Fn::Not': [{ 'Fn::Equals': [ref('HostedZoneId'), ''] }] }
    ] }
  },
  Resources: {
    LandingBucket: { Type:'AWS::S3::Bucket', DeletionPolicy:'Retain', UpdateReplacePolicy:'Retain', Properties:{
      BucketName:ref('BucketName'), PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true},
      OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]}, VersioningConfiguration:{Status:'Enabled'},
      BucketEncryption:{ServerSideEncryptionConfiguration:[{ServerSideEncryptionByDefault:{SSEAlgorithm:'AES256'}}]},
      Tags:[{Key:'Purpose',Value:'kinda-static-landing'}]
    } },
    LandingOac:{Type:'AWS::CloudFront::OriginAccessControl',Properties:{OriginAccessControlConfig:{Name:sub('${AWS::StackName}-oac'),OriginAccessControlOriginType:'s3',SigningBehavior:'always',SigningProtocol:'sigv4'}}},
    ViewerRequest:{Type:'AWS::CloudFront::Function',Properties:{Name:sub('${AWS::StackName}-routes'),AutoPublish:true,FunctionConfig:{Comment:'Exact Kinda public routes; preserve actual 404',Runtime:'cloudfront-js-2.0'},FunctionCode:viewerCode('landing','unpublished')}},
    HtmlCachePolicy:cache('html',60,300), AssetCachePolicy:cache('assets',31536000,31536000),
    SecurityHeaders:{Type:'AWS::CloudFront::ResponseHeadersPolicy',Properties:{ResponseHeadersPolicyConfig:{Name:sub('${AWS::StackName}-headers'),SecurityHeadersConfig:{
      StrictTransportSecurity:{AccessControlMaxAgeSec:31536000,IncludeSubdomains:false,Preload:false,Override:true},
      ContentTypeOptions:{Override:true},FrameOptions:{FrameOption:'DENY',Override:true},ReferrerPolicy:{ReferrerPolicy:'strict-origin-when-cross-origin',Override:true}
    },CustomHeadersConfig:{Items:[{Header:'Permissions-Policy',Value:'camera=(), microphone=(), geolocation=()',Override:true}]}}}},
    LandingDistribution:{Type:'AWS::CloudFront::Distribution',Properties:{Tags:[{Key:'Purpose',Value:'kinda-static-landing'}],DistributionConfig:{
      Enabled:true,Comment:'Dedicated Kinda static public landing',HttpVersion:'http2and3',IPV6Enabled:true,
      Aliases:choose([ref('DomainName')],ref('AWS::NoValue')),
      ViewerCertificate:choose({AcmCertificateArn:ref('CertificateArn'),SslSupportMethod:'sni-only',MinimumProtocolVersion:'TLSv1.2_2021'},{CloudFrontDefaultCertificate:true}),
      Origins:[{Id:'private-landing',DomainName:attr('LandingBucket','RegionalDomainName'),OriginAccessControlId:ref('LandingOac'),S3OriginConfig:{OriginAccessIdentity:''}}],
      DefaultCacheBehavior:behavior('HtmlCachePolicy'),CacheBehaviors:[{PathPattern:'/assets/*',...behavior('AssetCachePolicy')}],
      CustomErrorResponses:[403,404].map(code=>({ErrorCode:code,ResponseCode:404,ResponsePagePath:'/404.html',ErrorCachingMinTTL:0}))
    }}},
    LandingBucketPolicy:{Type:'AWS::S3::BucketPolicy',Properties:{Bucket:ref('LandingBucket'),PolicyDocument:{Version:'2012-10-17',Statement:[
      {Sid:'CloudFrontRead',Effect:'Allow',Principal:{Service:'cloudfront.amazonaws.com'},Action:'s3:GetObject',Resource:['index.html','404.html','assets/*','brand/*'].map(key=>sub(`\${LandingBucket.Arn}/${key}`)),Condition:{StringEquals:{'AWS:SourceArn':sub('arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${LandingDistribution}')}}},
      {Sid:'DenyInsecureTransport',Effect:'Deny',Principal:'*',Action:'s3:*',Resource:[attr('LandingBucket','Arn'),sub('${LandingBucket.Arn}/*')],Condition:{Bool:{'aws:SecureTransport':'false'}}}
    ]}}},
    DomainRecord:{Type:'AWS::Route53::RecordSet',Condition:'ManagedDns',Properties:{HostedZoneId:ref('HostedZoneId'),Name:ref('DomainName'),Type:'A',AliasTarget:{DNSName:attr('LandingDistribution','DomainName'),HostedZoneId:'Z2FDTNDATAQYW2'}}},
    DomainIpv6Record:{Type:'AWS::Route53::RecordSet',Condition:'ManagedDns',Properties:{HostedZoneId:ref('HostedZoneId'),Name:ref('DomainName'),Type:'AAAA',AliasTarget:{DNSName:attr('LandingDistribution','DomainName'),HostedZoneId:'Z2FDTNDATAQYW2'}}}
  },
  Outputs:{BucketName:{Value:ref('LandingBucket')},DistributionId:{Value:ref('LandingDistribution')},DistributionDomain:{Value:attr('LandingDistribution','DomainName')},OacId:{Value:ref('LandingOac')}}
};
/** Each function revision selects one immutable HTML release and one asset namespace. */
export function viewerCode(mode, release) {
  parseDeployMode(mode);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(release)) throw new Error('Invalid published release');
  const routes = mode === 'service' ? serviceRoutes : publicRoutes;
  const notFound = readFileSync(new URL('../../apps/web/404.html', import.meta.url), 'utf8');
  // Static 404 has no script or external dependencies; return it at the edge without
  // global origin-error remapping, which would swallow API authorization responses.
  return `function handler(event) {
    var request = event.request, uri = request.uri;
    var routes = ${JSON.stringify(routes)};
    var brands = ${JSON.stringify(brandAssets.map(key => '/' + key))};
    if (routes.indexOf(uri) !== -1 ${mode === 'service' ? `|| new RegExp(${JSON.stringify(floorEditorPattern)}).test(uri)` : ''}) {
      request.uri = '/published/${release}/index.html'; return request;
    }
    if (brands.indexOf(uri) !== -1) { request.uri = '/published/${release}' + uri; return request; }
    if (new RegExp(${JSON.stringify(`^/assets/${mode}/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]+\\.(?:js|css|svg|png|webp|jpg|jpeg|avif|woff2?|gif|ico)$`)}).test(uri) && uri.indexOf('..') === -1) return request;
    return { statusCode: 404, statusDescription: 'Not Found', headers: { 'content-type': { value: 'text/html; charset=utf-8' }, 'cache-control': { value: 'no-store' }, 'x-content-type-options': {value:'nosniff'} }, body: ${JSON.stringify(notFound)} };
  }`;
}
export function createTemplate(mode = 'landing', release = 'unpublished') {
  parseDeployMode(mode);
  const result = structuredClone(baseTemplate);
  result.Description = 'Kinda public Web deployment with immutable release routes and optional authenticated service API';
  result.Parameters.ApiOriginDomain = { Type:'String', Default:'', Description:'Preconfigured HTTPS origin hostname; must serve /api unchanged with a publicly trusted certificate.' };
  result.Resources.ViewerRequest.Properties.FunctionCode = viewerCode(mode, release);
  const d = result.Resources.LandingDistribution.Properties.DistributionConfig;
  // Zero error TTL preserves origin JSON/status and avoids caching API 403/404/5xx.
  d.CustomErrorResponses = [400,403,404,405,414,416,500,501,502,503,504].map(ErrorCode => ({ErrorCode,ErrorCachingMinTTL:0}));
  d.Comment = `Kinda Web ${mode} release ${release}`;
  d.DefaultCacheBehavior.CachePolicyId = cachingDisabledPolicyId;
  result.Resources.LandingBucketPolicy.Properties.PolicyDocument.Statement[0].Resource.push(sub('${LandingBucket.Arn}/published/*'));
  if (mode === 'service') {
    d.Origins.push({Id:'service-api',DomainName:ref('ApiOriginDomain'),CustomOriginConfig:{HTTPSPort:443,OriginProtocolPolicy:'https-only',OriginSSLProtocols:['TLSv1.2']}});
    d.CacheBehaviors.unshift(...['/api','/api/*'].map(PathPattern => ({
      PathPattern,TargetOriginId:'service-api',ViewerProtocolPolicy:'https-only',
      AllowedMethods:['GET','HEAD','OPTIONS','PUT','PATCH','POST','DELETE'],CachedMethods:['GET','HEAD'],
      CachePolicyId:cachingDisabledPolicyId,
      // Managed AllViewerExceptHostHeader forwards cookies, query and Authorization;
      // origin Host remains the API TLS hostname, preventing certificate mismatch.
      OriginRequestPolicyId:'b689b0a8-53d0-40ab-baf2-68738e2966ac',Compress:true
    })));
  }
  result.Outputs.DeployMode = {Value:mode};
  result.Outputs.ReleaseId = {Value:release};
  return result;
}
export const template = createTemplate();
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(`${JSON.stringify(createTemplate(parseDeployMode(process.env.WEB_DEPLOY_MODE)),null,2)}\n`);
