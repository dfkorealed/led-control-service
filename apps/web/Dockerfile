FROM node:22.20.0-alpine3.22 AS build

WORKDIR /app

RUN apk add --no-cache procps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY patches patches
RUN corepack enable && pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/shared packages/shared
RUN pnpm --filter @led-control/shared build
RUN pnpm --filter @led-control/web build

FROM nginx:1.27.5-alpine

# Render only the HTTPS origin. nginx variables must survive envsubst unchanged.
ENV NGINX_ENVSUBST_FILTER=WEB_HTTPS_ORIGIN
RUN sed -i 's@^pid .*;@pid /tmp/nginx.pid;@; /user  nginx;/d' /etc/nginx/nginx.conf
RUN printf '\ninclude /etc/nginx/stream.conf;\n' >> /etc/nginx/nginx.conf

COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY apps/web/nginx.stream.conf /etc/nginx/stream.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

USER nginx
EXPOSE 8080 8443 9443
