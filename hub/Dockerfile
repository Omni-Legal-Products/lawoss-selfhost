# Hub image. Build context: hub/ (docker build -f hub/Dockerfile hub).
# Same Node base as auth/Dockerfile, pinned by digest.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
# git and CA certificates only for fetching the catalog in this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json services.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev --ignore-scripts
# Runtimes from the public catalog at the reviewed catalogCommit in services.json (no build argument
# can change it), verified file by file against each runtime's provenance.
RUN set -eu; \
    commit="$(node -p "require('./services.json').catalogCommit")"; \
    git init -q /catalog; \
    git -C /catalog fetch -q --depth 1 https://github.com/Omni-Legal-Products/lawoss-marketplace.git "$commit"; \
    test "$(git -C /catalog rev-parse FETCH_HEAD)" = "$commit"; \
    node scripts/fetch-runtimes.mjs --catalog /catalog --catalog-commit "$commit" --out /opt/lawoss/runtimes; \
    rm -rf /catalog
# The only step that may use npm and the network for runtime dependencies: run each launcher once
# so that it installs (or, for bundled runtimes, copies) its locked files into the shared cache.
ENV LAWOSS_CACHE_DIR=/opt/lawoss/cache
RUN set -eu; \
    for launcher in /opt/lawoss/runtimes/*/scripts/run.mjs; do \
      LAWOSS_STATE_DIR=/tmp/lawoss-warm node "$launcher" tools > /dev/null; \
      node "$launcher" doctor | node -e "process.exit(JSON.parse(require('fs').readFileSync(0,'utf8')).cached === true ? 0 : 1)"; \
    done; \
    rm -rf /tmp/lawoss-warm /opt/lawoss/cache/.install.lock; \
    chown -R root:root /opt/lawoss; \
    chmod -R a+rX,go-w /opt/lawoss

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
# Runtimes start from the warmed cache only: no package manager is left in the image (the launcher
# would otherwise also find npm beside the node binary).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && ! command -v npm && ! command -v npx && ! command -v yarn \
 && mkdir /data && chown node:node /data && chmod 0700 /data
WORKDIR /app
COPY --from=build /app/package.json /app/services.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/runtime-verify.mjs ./scripts/runtime-verify.mjs
# Root-owned and read-only for the node user; verified again at every start.
COPY --from=build /opt/lawoss /opt/lawoss
ENV NODE_ENV=production \
    PORT=3000 \
    LAWOSS_RUNTIMES_DIR=/opt/lawoss/runtimes \
    LAWOSS_CACHE_DIR=/opt/lawoss/cache \
    LAWOSS_DATA_DIR=/data
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
