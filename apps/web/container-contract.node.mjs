import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
const dockerfile = readFileSync(path.join(import.meta.dirname, "Dockerfile"), "utf8");
const nginx = readFileSync(path.join(import.meta.dirname, "nginx.conf.template"), "utf8");
test("Web retains frozen patched install and Shared build process inspection", () => {
  assert.match(dockerfile, /COPY patches patches\s+RUN corepack enable && pnpm install --frozen-lockfile/);
  assert.match(dockerfile, /RUN apk add --no-cache procps/);
  assert.ok(dockerfile.indexOf("@led-control/shared build") < dockerfile.indexOf("@led-control/web build"));
});
test("Web serves TLS 1.2/1.3 as non-root and redirects HTTP to explicit HTTPS origin", () => {
  assert.match(dockerfile, /USER (?:nginx|101)/);
  assert.match(nginx, /listen 8443 ssl/);
  assert.match(nginx, /ssl_protocols TLSv1\.2 TLSv1\.3/);
  assert.match(nginx, /return 308 \$\{WEB_HTTPS_ORIGIN\}\$request_uri/);
  assert.match(nginx, /ssl_certificate_key \/run\/web-tls\//);
});
test("Web verifies API identity and forwards correlation without trusting client chains", () => {
  assert.match(nginx, /proxy_pass https:\/\/api:4000\//);
  assert.match(nginx, /proxy_ssl_verify on/);
  assert.match(nginx, /proxy_ssl_server_name on/);
  assert.match(nginx, /proxy_ssl_trusted_certificate \/run\/api-tls\/api-ca.crt/);
  assert.match(nginx, /proxy_set_header X-Request-Id \$http_x_request_id/);
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr/);
  assert.doesNotMatch(nginx, /proxy_add_x_forwarded_for/);
});
test("Web distinguishes immutable assets from shell and sets security headers", () => {
  assert.match(nginx, /immutable/);
  assert.match(nginx, /location = \/index.html/);
  assert.match(nginx, /no-cache/);
  for (const header of ["Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"]) assert.match(nginx, new RegExp(header));
  assert.match(nginx, /try_files \$uri \$uri\/ \/index\.html/);
});

test("Web offers a raw TCP API listener without TLS termination or certificate-header trust", () => {
  const filename = path.join(import.meta.dirname, "nginx.stream.conf");
  assert.ok(existsSync(filename), "socket mTLS requires an independent stream listener");
  const stream = readFileSync(filename, "utf8");
  assert.match(stream, /stream\s*\{/);
  assert.match(stream, /listen 9443;/);
  assert.match(stream, /proxy_pass api:4000;/);
  assert.doesNotMatch(stream, /ssl_certificate|listen[^;]*ssl|proxy_ssl|proxy_set_header/);
  assert.match(dockerfile, /COPY apps\/web\/nginx\.stream\.conf \/etc\/nginx\/stream\.conf/);
  assert.match(dockerfile, /include \/etc\/nginx\/stream\.conf/);
  assert.doesNotMatch(nginx, /proxy_set_header.*(?:Client-Cert|SSL-Cert|Certificate)/i);
});
