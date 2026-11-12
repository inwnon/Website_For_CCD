# Production image for the app (docker compose --profile app up -d --build).
# Packages are installed once at build time, so a restart never depends on the npm registry.
# Base image pinned by digest (Dependabot keeps it current), so a build gets exactly the image that was tested.
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no package install script runs (supply-chain safety); sharp ships prebuilt binaries
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
ENV NODE_ENV=production TZ=Asia/Bangkok
# The app runs with node alone: drop npm, npx, yarn and corepack (smaller image, fewer tools for an attacker)
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn* /opt/yarn*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Code stays owned by root (read-only for the app); only uploads/ is writable by the app user.
# pg_dump for the nightly backup (server/backup.mjs); same major version as the db image
RUN apk add --no-cache postgresql16-client
RUN mkdir -p uploads backups && chown node:node uploads
USER node
EXPOSE 3000
CMD ["sh", "-c", "node server/migrate.mjs && node server/index.mjs"]
