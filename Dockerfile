# Production image for the app (docker compose --profile app up -d --build).
# Packages are installed once at build time, so a restart never depends on the npm registry.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production TZ=Asia/Bangkok
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Code stays owned by root (read-only for the app); only uploads/ is writable by the app user.
RUN mkdir -p uploads backups && chown node:node uploads
USER node
EXPOSE 3000
CMD ["sh", "-c", "node server/migrate.mjs && node server/index.mjs"]
