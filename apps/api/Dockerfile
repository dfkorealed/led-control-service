FROM node:22.20.0-alpine3.22 AS build
WORKDIR /app
RUN apk add --no-cache procps openssl
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/automation-engine/package.json packages/automation-engine/package.json
COPY patches patches
RUN corepack enable && pnpm install --frozen-lockfile
COPY apps/api apps/api
COPY packages/shared packages/shared
COPY packages/automation-engine packages/automation-engine
RUN pnpm --filter @led-control/api prisma:generate
RUN pnpm --filter @led-control/shared build
RUN pnpm --filter @led-control/automation-engine build
RUN pnpm --filter @led-control/api build
RUN pnpm --filter @led-control/api deploy --prod /runtime
# Prisma CLI is a migration-only dependency. Copy its exact installed dependency
# closure instead of shipping Nest/Jest/TypeScript or downloading a second version.
RUN node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const copied = new Map();
function copyPackage(location) {
  location = fs.realpathSync(location);
  if (copied.has(location)) return copied.get(location);
  const pkg = JSON.parse(fs.readFileSync(path.join(location, 'package.json')));
  const target = '/migration/store/' + pkg.name.replace('/', '+') + '@' + pkg.version;
  copied.set(location, target);
  fs.cpSync(location, target, {recursive:true, filter: src => !src.includes('/node_modules/', location.length)});
  const resolve = createRequire(path.join(location, 'package.json'));
  for (const name of Object.keys(pkg.dependencies || {})) {
    // Package exports may hide package.json. Follow Node's package search paths
    // on disk so the installed pnpm graph remains the source of truth.
    const dependency = resolve.resolve.paths(name).map(base => path.join(base, name)).find(fs.existsSync);
    if (!dependency) throw new Error('Missing migration dependency: ' + name);
    const child = copyPackage(dependency);
    const link = path.join(target, 'node_modules', name);
    fs.mkdirSync(path.dirname(link), {recursive:true});
    fs.symlinkSync(path.relative(path.dirname(link), child), link);
  }
  return target;
}
const cli = copyPackage('/app/apps/api/node_modules/prisma');
fs.symlinkSync(path.relative('/migration', cli), '/migration/prisma');
const client = path.dirname(fs.realpathSync('/app/apps/api/node_modules/@prisma/client'));
// pnpm deploy runs the client postinstall and leaves a local stub next to its
// runtime package. Replace that nearest resolution target with generated code.
const runtimeClient = path.dirname(fs.realpathSync('/runtime/node_modules/@prisma/client'));
fs.cpSync(path.resolve(client, '../.prisma'), path.resolve(runtimeClient, '../.prisma'), {recursive:true});
NODE

FROM node:22.20.0-alpine3.22 AS runtime
RUN apk add --no-cache tini openssl
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./dist
COPY --from=build --chown=node:node /app/apps/api/prisma ./prisma
COPY --from=build --chown=node:node /migration /migration
COPY --chown=node:node apps/api/container-init-crls.cjs ./container-init-crls.cjs
RUN node -e "const assert=require('node:assert/strict');const {Prisma}=require('@prisma/client');assert.equal(new Prisma.Decimal('1.25').toString(),'1.25');require('@led-control/shared');require('@led-control/automation-engine');"
# New named volumes inherit these directory owners. No root/chown capability is
# needed by the one-shot initializer or API when publishing public CRL state.
RUN mkdir /run/device-crl /run/mqtt-crl && chown node:node /run/device-crl /run/mqtt-crl
USER node
EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/main.js"]
