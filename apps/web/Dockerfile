FROM node:22-alpine AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN corepack enable && pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/shared packages/shared
RUN pnpm --filter @led-control/shared build
RUN pnpm --filter @led-control/web build

FROM nginx:1.27-alpine

ENV API_UPSTREAM=http://api:4000

COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
