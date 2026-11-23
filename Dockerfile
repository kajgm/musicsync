# One image: the server (TypeScript run directly by Node 26), its engine worker and the
# built web app (architecture §10).
#   docker build --build-arg APP_VERSION=0.1.0 -t musicsync .
#   docker run -p 3000:3000 -v musicsync-data:/data --env-file musicsync.env musicsync

# Nothing here is native (SQLite is node:sqlite, DTLS is plain JS), so node_modules and
# the web build are the same for every platform: build on the host's arch, copy across.
FROM --platform=$BUILDPLATFORM node:26.13.1-slim AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/engine/package.json packages/engine/
COPY packages/audio-features/package.json packages/audio-features/
COPY packages/hue/package.json packages/hue/
COPY packages/spotify/package.json packages/spotify/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/sensor-agent/package.json apps/sensor-agent/

FROM manifests AS build
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM manifests AS prod-deps
# Optional deps are only native crypto fallbacks for Node < 10.
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund

FROM node:26.13.1-slim
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
# /data holds musicsync.db. Owned by `node` so a fresh volume is writable; the rest of
# the filesystem can stay read-only.
RUN mkdir /data && chown node:node /data
# Built-in non-root `node` user (uid 1000).
USER node
EXPOSE 3000
CMD ["node", "apps/server/src/main.ts"]
