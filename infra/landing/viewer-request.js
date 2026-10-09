// Exact public page allowlist: do not introduce a catch-all SPA rewrite.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === '/' || uri === '/features' || uri === '/pricing') {
    request.uri = '/index.html';
  } else if (uri !== '/404.html' && !/^\/(assets|brand)\/[A-Za-z0-9_./-]+$/.test(uri)) {
    request.uri = '/__not-found__';
  } else if (uri.indexOf('..') !== -1 || uri.indexOf('//') !== -1) {
    request.uri = '/__not-found__';
  }
  // S3 intentionally has no such object. Private-origin 403 is mapped to real 404.
  return request;
}
