# syntax=docker/dockerfile:1
# Build context is the repository root (needed for the shared tsconfig.base.json).
FROM node:22-alpine AS build
WORKDIR /app
# Retry package downloads on flaky connections (for example under amd64 emulation).
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=10000 npm_config_fetch_retry_maxtimeout=60000
RUN apk add --no-cache openssl
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/tuition-api/package.json apps/tuition-api/
RUN npm ci --workspace apps/tuition-api --include-workspace-root=false
COPY apps/tuition-api/tsconfig*.json apps/tuition-api/
COPY apps/tuition-api/prisma apps/tuition-api/prisma
COPY apps/tuition-api/src apps/tuition-api/src
WORKDIR /app/apps/tuition-api
RUN npx prisma generate && npx tsc -p tsconfig.build.json

FROM node:22-alpine AS runtime
WORKDIR /app
# Retry package downloads on flaky connections (for example under amd64 emulation).
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=10000 npm_config_fetch_retry_maxtimeout=60000
ENV NODE_ENV=production
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY apps/tuition-api/package.json apps/tuition-api/
RUN npm ci --omit=dev --workspace apps/tuition-api --include-workspace-root=false
COPY apps/tuition-api/prisma apps/tuition-api/prisma
WORKDIR /app/apps/tuition-api
RUN npx prisma generate
COPY --from=build /app/apps/tuition-api/dist ./dist
EXPOSE 3000
# Apply pending migrations (idempotent), load the demo data if SEED_ON_START=true and the database is
# empty, then start the API. Demo data can also be loaded on demand: node dist/seed/seed.js
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/seed/seed.js --on-start && exec node dist/main.js"]
