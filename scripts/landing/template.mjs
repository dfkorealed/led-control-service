import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const ref = (name) => ({ Ref: name });
const attr = (name, key) => ({ 'Fn::GetAtt': [name, key] });
const sub = (value) => ({ 'Fn::Sub': value });
const choose = (yes, no) => ({ 'Fn::If': ['CustomDomain', yes, no] });
const cache = (name, ttl, max) => ({ Type: 'AWS::CloudFront::CachePolicy', Properties: { CachePolicyConfig: {
  Name: sub(`\${AWS::StackName}-${name}`), MinTTL: 0, DefaultTTL: ttl, MaxTTL: max,
  ParametersInCacheKeyAndForwardedToOrigin: { EnableAcceptEncodingGzip: true, EnableAcceptEncodingBrotli: true, CookiesConfig: { CookieBehavior: 'none' }, HeadersConfig: { HeaderBehavior: 'none' }, QueryStringsConfig: { QueryStringBehavior: 'none' } }
} } });
const behavior = (policy) => ({ TargetOriginId: 'private-landing', ViewerProtocolPolicy: 'redirect-to-https', AllowedMethods: ['GET','HEAD'], CachedMethods: ['GET','HEAD'], Compress: true, CachePolicyId: ref(policy), ResponseHeadersPolicyId: ref('SecurityHeaders'), FunctionAssociations: [{ EventType: 'viewer-request', FunctionARN: attr('ViewerRequest', 'FunctionARN') }] });
export const template = {
  AWSTemplateFormatVersion: '2010-09-09', Description: 'Dedicated Kinda public landing: private S3, CloudFront OAC, exact routes. Pay-as-you-go; no pricing plan subscription.',
  Parameters: {
    BucketName: { Type: 'String', AllowedPattern: '[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]' },
    DomainName: { Type: 'String', Default: '' },
    CertificateArn: { Type: 'String', Default: '', Description: 'Existing ISSUED ACM certificate in us-east-1; do not create or replace certificates.' },
    HostedZoneId: { Type: 'String', Default: '', Description: 'Existing public Route 53 zone; required with DomainName.' }
  },
  Conditions: { CustomDomain: { 'Fn::Not': [{ 'Fn::Equals': [ref('DomainName'), ''] }] } },
  Resources: {
    LandingBucket: { Type:'AWS::S3::Bucket', DeletionPolicy:'Retain', UpdateReplacePolicy:'Retain', Properties:{
      BucketName:ref('BucketName'), PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true},
      OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]}, VersioningConfiguration:{Status:'Enabled'},
      BucketEncryption:{ServerSideEncryptionConfiguration:[{ServerSideEncryptionByDefault:{SSEAlgorithm:'AES256'}}]},
      Tags:[{Key:'Purpose',Value:'kinda-static-landing'}]
    } },
    LandingOac:{Type:'AWS::CloudFront::OriginAccessControl',Properties:{OriginAccessControlConfig:{Name:sub('${AWS::StackName}-oac'),OriginAccessControlOriginType:'s3',SigningBehavior:'always',SigningProtocol:'sigv4'}}},
    ViewerRequest:{Type:'AWS::CloudFront::Function',Properties:{Name:sub('${AWS::StackName}-routes'),AutoPublish:true,FunctionConfig:{Comment:'Exact Kinda public routes; preserve actual 404',Runtime:'cloudfront-js-2.0'},FunctionCode:readFileSync(new URL('../../infra/landing/viewer-request.js',import.meta.url),'utf8')}},
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
    DomainRecord:{Type:'AWS::Route53::RecordSet',Condition:'CustomDomain',Properties:{HostedZoneId:ref('HostedZoneId'),Name:ref('DomainName'),Type:'A',AliasTarget:{DNSName:attr('LandingDistribution','DomainName'),HostedZoneId:'Z2FDTNDATAQYW2'}}},
    DomainIpv6Record:{Type:'AWS::Route53::RecordSet',Condition:'CustomDomain',Properties:{HostedZoneId:ref('HostedZoneId'),Name:ref('DomainName'),Type:'AAAA',AliasTarget:{DNSName:attr('LandingDistribution','DomainName'),HostedZoneId:'Z2FDTNDATAQYW2'}}}
  },
  Outputs:{BucketName:{Value:ref('LandingBucket')},DistributionId:{Value:ref('LandingDistribution')},DistributionDomain:{Value:attr('LandingDistribution','DomainName')},OacId:{Value:ref('LandingOac')}}
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(`${JSON.stringify(template,null,2)}\n`);
