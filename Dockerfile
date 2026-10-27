ARG NODE_IMAGE="node:22.23.4-alpine3.23@sha256:206878a60dc7014193f418ab9259b6110c15fbd514b3044a267be706509944e4"
ARG BUN_VERSION="1.3.0"

FROM oven/bun:${BUN_VERSION}-alpine AS bun_base
FROM ${NODE_IMAGE} AS node_base

COPY packages/backend/scripts/verify-node-security.cjs /usr/local/lib/orbis/verify-node-security.cjs
RUN node /usr/local/lib/orbis/verify-node-security.cjs

# ---- BUILDER BASE ----
FROM bun_base AS builder_base

WORKDIR /deps

ENV DO_NOT_TRACK=1 \
    TURBO_TELEMETRY_DISABLED=1

ARG TARGETARCH
ARG DOCKER_COMPOSE_VERSION="v2.40.0"
ENV TARGETARCH=${TARGETARCH}

RUN apk add --no-cache curl python3 make g++ git

RUN echo "Building for ${TARGETARCH}"
RUN if [ "${TARGETARCH}" = "arm64" ]; then \
      curl -L -o docker-binary "https://github.com/docker/compose/releases/download/$DOCKER_COMPOSE_VERSION/docker-compose-linux-aarch64"; \
      elif [ "${TARGETARCH}" = "amd64" ]; then \
      curl -L -o docker-binary "https://github.com/docker/compose/releases/download/$DOCKER_COMPOSE_VERSION/docker-compose-linux-x86_64"; \
      fi

RUN chmod +x docker-binary

# ---- RUNNER BASE ----
FROM node_base AS runner_base

RUN apk add --no-cache curl openssl git file tar coreutils

# ---- BUILDER ----
FROM builder_base AS builder

WORKDIR /app

COPY ./bun.lock ./
COPY ./package.json ./
COPY ./packages/backend/package.json ./packages/backend/package.json
COPY ./packages/frontend/package.json ./packages/frontend/package.json
COPY ./packages/common/package.json ./packages/common/package.json
COPY ./packages/frontend/scripts ./packages/frontend/scripts
COPY ./packages/frontend/public ./packages/frontend/public

RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --ignore-scripts && \
    cd packages/frontend && ./scripts/postinstall.sh

COPY ./turbo.json ./turbo.json
COPY ./packages ./packages
RUN bun run build

RUN bun run bundle
RUN bun packages/backend/scripts/package-runtime-dependencies.ts /app/packages/backend /app/runtime-node-modules /app/bun.lock

# ---- RUNNER ----
FROM runner_base AS runner

ENV NODE_ENV="production"

ARG ORBIS_VERSION=development
ARG ORBIS_COMMIT
ENV ORBIS_VERSION=${ORBIS_VERSION}
ENV ORBIS_COMMIT=${ORBIS_COMMIT}
LABEL io.orbis.installation-protocol="orbis.installation-state.v1"
LABEL io.orbis.network-prune-scope="orbis.managed"

WORKDIR /app

COPY --from=builder /app/runtime-node-modules ./node_modules
COPY --from=builder /app/packages/backend/scripts/verify-node-security.cjs ./verify-node-security.cjs
COPY --from=builder /app/packages/backend/scripts/verify-runtime-dependencies.cjs ./verify-runtime-dependencies.cjs
RUN node ./verify-runtime-dependencies.cjs
COPY --from=builder_base /deps/docker-binary /usr/local/bin/docker-compose
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/backend/dist ./

# Assets
COPY --from=builder /app/packages/backend/assets ./assets
COPY --from=builder /app/packages/backend/src/core/database/drizzle ./assets/migrations
COPY --from=builder /app/packages/backend/src/modules/i18n/translations ./assets/translations
COPY --from=builder /app/packages/frontend/dist/client ./assets/frontend

EXPOSE 3000

RUN mv main.js main.mjs && mv restore-worker.js restore-worker.mjs

CMD ["node", "./main.mjs"]
