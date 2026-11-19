# syntax=docker/dockerfile:1
# Web chat (the agent behind a small HTTP server). Build context is the repository root.
FROM node:22-alpine AS build
WORKDIR /app
# Retry package downloads on flaky connections (for example under amd64 emulation).
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=10000 npm_config_fetch_retry_maxtimeout=60000
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/agent/package.json apps/agent/
RUN npm ci --workspace apps/agent --include-workspace-root=false
COPY apps/agent/tsconfig*.json apps/agent/
COPY apps/agent/src apps/agent/src
WORKDIR /app/apps/agent
RUN npx tsc -p tsconfig.build.json

FROM node:22-alpine AS runtime
WORKDIR /app
# Retry package downloads on flaky connections (for example under amd64 emulation).
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=10000 npm_config_fetch_retry_maxtimeout=60000
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/agent/package.json apps/agent/
RUN npm ci --omit=dev --workspace apps/agent --include-workspace-root=false
WORKDIR /app/apps/agent
COPY apps/agent/public ./public
COPY --from=build /app/apps/agent/dist ./dist
EXPOSE 8080
CMD ["node", "dist/serve.js"]
