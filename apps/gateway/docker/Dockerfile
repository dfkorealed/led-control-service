# syntax=docker/dockerfile:1.7
FROM debian:bookworm-slim AS bluez-builder

ARG BLUEZ_VERSION=5.82
ARG BLUEZ_SHA256=0739fa608a837967ee6d5572b43fb89946a938d1c6c26127158aaefd743a790b

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl libdbus-1-dev libell-dev libglib2.0-dev libjson-c-dev \
      libreadline-dev pkg-config xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSLO "https://www.kernel.org/pub/linux/bluetooth/bluez-${BLUEZ_VERSION}.tar.xz" \
    && echo "${BLUEZ_SHA256}  bluez-${BLUEZ_VERSION}.tar.xz" | sha256sum -c - \
    && tar -xf "bluez-${BLUEZ_VERSION}.tar.xz" \
    && cd "bluez-${BLUEZ_VERSION}" \
    && ./configure --enable-mesh --disable-obex --disable-udev --disable-cups \
      --disable-monitor --disable-client --disable-datafiles \
      --disable-systemd --disable-manpages \
    && make -j"$(nproc)" mesh/bluetooth-meshd tools/btmgmt

FROM node:22-bookworm-slim AS app-builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @led-control/gateway...
COPY apps/gateway/src apps/gateway/src
COPY apps/gateway/scripts apps/gateway/scripts
COPY apps/gateway/tsconfig.json apps/gateway/tsconfig.json
COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
RUN pnpm --filter @led-control/shared build \
    && pnpm --filter @led-control/gateway exec esbuild src/index.ts \
      --bundle --platform=node --format=esm --target=node22 --packages=external \
      --outfile=/tmp/gateway.mjs \
    && pnpm --filter @led-control/gateway deploy --prod /tmp/gateway-runtime \
    && find /tmp/gateway-runtime/node_modules -type f -name '*.md' -delete

RUN pnpm --filter @led-control/gateway exec esbuild scripts/manufacturing-enroll.ts \
      --bundle --platform=node --format=esm --target=node22 --outfile=/tmp/manufacturing-enroll.mjs

FROM node:22-bookworm-slim AS runtime
# Bookworm is the OpenSSL 3.0 minor-version contract. Without a Debian snapshot,
# an exact patch pin would disappear as security repositories advance.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl dbus dbus-bin libdbus-1-3 libell0 libjson-c5 libreadline8 libudev1 openssl procps util-linux \
    && openssl version | grep -Eq '^OpenSSL 3\.0\.' \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system gateway \
    && useradd --system --gid gateway --home-dir /var/lib/led-control --shell /usr/sbin/nologin gateway

COPY --from=bluez-builder /src/bluez-5.82/mesh/bluetooth-meshd /usr/local/sbin/bluetooth-meshd
COPY --from=bluez-builder /src/bluez-5.82/tools/btmgmt /usr/local/bin/btmgmt
COPY --from=app-builder /tmp/gateway.mjs /opt/led-control/gateway.mjs
COPY --from=app-builder /tmp/manufacturing-enroll.mjs /usr/local/bin/manufacturing-enroll.mjs
COPY --from=app-builder /tmp/gateway-runtime/node_modules /opt/led-control/node_modules
COPY apps/gateway/docker/dbus-system.conf /etc/dbus-1/gateway-system.conf
COPY apps/gateway/docker/bluetooth-mesh.conf /etc/dbus-1/system.d/bluetooth-mesh.conf
COPY apps/gateway/docker/entrypoint.sh /usr/local/bin/gateway-entrypoint
COPY apps/gateway/docker/healthcheck.sh /usr/local/bin/gateway-healthcheck
COPY apps/gateway/docker/healthcheck-state.cjs /usr/local/lib/gateway-healthcheck-state.cjs

RUN chmod 0755 /usr/local/bin/gateway-entrypoint /usr/local/bin/gateway-healthcheck \
    && chmod 0755 /usr/local/bin/btmgmt /usr/local/bin/manufacturing-enroll.mjs \
    && mkdir -p /var/lib/led-control/identity /var/lib/bluetooth/mesh /run/dbus \
    && chown -R gateway:gateway /var/lib/led-control

ENV NODE_ENV=production
ENV DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket
WORKDIR /opt/led-control
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 CMD ["/usr/local/bin/gateway-healthcheck"]
ENTRYPOINT ["/usr/local/bin/gateway-entrypoint"]
