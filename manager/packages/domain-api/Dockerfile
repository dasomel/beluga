# syntax=docker/dockerfile:1
#
# Build context is the repo root (npm workspace), e.g.:
#   docker build -f packages/domain-api/Dockerfile -t ghcr.io/dasomel/beluga-manager-domain-api:local-verify .
#
# domain-api has no native-binary dependencies (hono/zod/@hono/* are pure JS — see
# docs/adr/0002-backend-api-technology.md Decision Drivers #6), so alpine is used for both
# stages; verified by building this image, not assumed.

FROM node:22-alpine AS build
WORKDIR /app

# Install only this workspace's dependency closure (+ root devDependencies for the
# toolchain) rather than the whole monorepo's — `npm ci --workspace` resolves against the
# real committed root package-lock.json, so this keeps the reproducibility/integrity
# guarantee docs/dependency-incident-response.md relies on while not installing
# packages/web's React/Vite toolchain into this image's build stage.
COPY package.json package-lock.json ./
COPY packages/domain-api/package.json packages/domain-api/package.json
RUN npm ci --workspace=packages/domain-api --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/domain-api packages/domain-api

# tsconfig.json (tsc --noEmit) is the same check CI already runs; repeating it here makes
# the image build itself fail closed on a type error instead of only relying on CI having
# run first. tsconfig.build.json (added alongside this Dockerfile) produces the real
# emitted JS this production image ships, instead of running the TS source through tsx.
# It exists because tsconfig.json's inherited `outDir` resolves relative to the shared
# ../../tsconfig.base.json that defines it (i.e. to the repo root), not to this package —
# confirmed by actually emitting with it — so a dedicated build config pins `rootDir`/
# `outDir` to this package and excludes tests/ from the compiled output.
RUN npm run typecheck --workspace=packages/domain-api \
 && npm run build --workspace=packages/domain-api

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/domain-api/package.json packages/domain-api/package.json
RUN npm ci --omit=dev --workspace=packages/domain-api --include-workspace-root \
 && npm cache clean --force

# health.ts reads this package's own package.json (for the health response's `version`
# field) via a path relative to its compiled location, so it must ship alongside dist/.
COPY --from=build /app/packages/domain-api/dist packages/domain-api/dist

EXPOSE 8787
USER node

# 127.0.0.1, not localhost: nginx's sibling Dockerfile hit a real IPv6-loopback
# connection-refused failure using `localhost` for its healthcheck (that server only
# binds IPv4). @hono/node-server's default bind happens to be dual-stack so `localhost`
# would likely work here too, but pinning the same explicit address in both images avoids
# relying on that default rather than proving it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "packages/domain-api/dist/server.js"]
