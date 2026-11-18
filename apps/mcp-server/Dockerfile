# syntax=docker/dockerfile:1
# Build context is the repository root (needed for the shared tsconfig.base.json).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/mcp-server/package.json apps/mcp-server/
RUN npm ci --workspace apps/mcp-server --include-workspace-root=false
COPY apps/mcp-server/tsconfig*.json apps/mcp-server/
COPY apps/mcp-server/src apps/mcp-server/src
WORKDIR /app/apps/mcp-server
RUN npx tsc -p tsconfig.build.json

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/mcp-server/package.json apps/mcp-server/
RUN npm ci --omit=dev --workspace apps/mcp-server --include-workspace-root=false
WORKDIR /app/apps/mcp-server
COPY apps/mcp-server/data ./data
COPY --from=build /app/apps/mcp-server/dist ./dist
EXPOSE 3001
CMD ["node", "dist/index.js"]
