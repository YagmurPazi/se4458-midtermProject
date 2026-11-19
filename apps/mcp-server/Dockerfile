# syntax=docker/dockerfile:1
# Build context is the repository root (needed for the shared tsconfig.base.json).
FROM node:22-alpine AS build
WORKDIR /app
# Retry package downloads on flaky connections (for example under amd64 emulation).
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=10000 npm_config_fetch_retry_maxtimeout=60000
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/mcp-server/package.json apps/mcp-server/
RUN npm ci --workspace apps/mcp-server --include-workspace-root=false
COPY apps/mcp-server/tsconfig*.json apps/mcp-server/
COPY apps/mcp-server/src apps/mcp-server/src
COPY apps/mcp-server/data apps/mcp-server/data
WORKDIR /app/apps/mcp-server
# Compiles the server and builds the policy search index (dist/policy-index.json) at image build time.
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
# Retry package downloads on flaky connections (for example under amd64 emulation).
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=10000 npm_config_fetch_retry_maxtimeout=60000
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/mcp-server/package.json apps/mcp-server/
RUN npm ci --omit=dev --workspace apps/mcp-server --include-workspace-root=false
WORKDIR /app/apps/mcp-server
COPY --from=build /app/apps/mcp-server/dist ./dist
EXPOSE 3001
CMD ["node", "dist/index.js"]
