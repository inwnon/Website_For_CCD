# Production image for the app (docker compose --profile app up -d --build).
# Packages are installed once at build time, so a restart never depends on the npm registry.
# Base image pinned by digest (Dependabot keeps it current), so a build gets exactly the image that was tested.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no package install script runs (supply-chain safety); sharp ships prebuilt binaries
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
ENV NODE_ENV=production TZ=Asia/Bangkok
# The app runs with node alone: drop npm, npx, yarn and corepack (smaller image, fewer tools for an attacker)
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn* /opt/yarn*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Code stays owned by root (read-only for the app); only uploads/ is writable by the app user.
RUN mkdir -p uploads backups && chown node:node uploads
USER node
EXPOSE 3000
CMD ["sh", "-c", "node server/migrate.mjs && node server/index.mjs"]
