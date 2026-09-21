# syntax=docker/dockerfile:1
#
# Build context is the repo root (npm workspace), e.g.:
#   docker build -f packages/web/Dockerfile -t ghcr.io/dasomel/beluga-manager-web:local-verify .
#
# This package is a static Vite SPA build (`vite build` -> packages/web/dist/), not a
# long-running Node process, so only the build stage needs Node; the runtime stage is a
# static file server with no JS runtime at all.

FROM node:22-alpine AS build
WORKDIR /app

# @beluga-manager/web depends on @beluga-manager/domain-api (workspace protocol) purely
# for shared Zod-derived types (src/api/types.ts, hooks.ts, components/*, views/*) via the
# "./schema" export, which resolves to domain-api's raw TypeScript source, not compiled
# JS (see packages/domain-api/package.json "exports"). npm's workspace symlink still
# requires that source physically present at build time, or typecheck fails with
# "Cannot find module '@beluga-manager/domain-api/schema'" (confirmed by building without
# it) -- so both packages are copied into this build stage, even though the runtime stage
# below ships neither Node nor either package's source.
COPY package.json package-lock.json ./
COPY packages/web/package.json packages/web/package.json
COPY packages/domain-api/package.json packages/domain-api/package.json
RUN npm ci --workspace=packages/web --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/domain-api packages/domain-api
COPY packages/web packages/web

# "build": "tsc --noEmit && vite build" (packages/web/package.json) -- typecheck then the
# real Vite production build. Vite copies public/* (incl. config.json) into dist/ as-is.
RUN npm run build --workspace=packages/web

# nginx over a Node static-file server: this stage ships zero JS runtime, nginx:alpine is
# ~40MB, and SPA history-fallback is a single `try_files` line -- there's no server-side
# logic here to justify carrying Node into a purely-static-files image.
FROM nginx:alpine AS runtime

COPY --from=build /app/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# 127.0.0.1, not localhost: this nginx.conf only has `listen 80;` (IPv4), matching
# nginx:alpine's own stock default.conf, so a `localhost` that resolves to the IPv6
# loopback first gets connection-refused inside the container -- confirmed by hitting
# this exact failure with `localhost` before switching to an explicit IPv4 address.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1/ || exit 1
