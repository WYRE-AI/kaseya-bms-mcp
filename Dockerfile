# Multi-stage build for efficient container size
FROM node:26-alpine AS builder

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

WORKDIR /app

COPY package*.json ./

# Install dependencies using Docker build secret for GitHub Packages auth
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --ignore-scripts

COPY . .

RUN npm run build

# Prune dev dependencies in builder stage (must happen here while npmrc secret is available)
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm prune --omit=dev

# Production stage
FROM node:26-alpine AS production

RUN addgroup -g 1001 -S kaseya && \
    adduser -S kaseya -u 1001 -G kaseya

WORKDIR /app

COPY package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

RUN npm cache clean --force

RUN mkdir -p /app/logs && chown -R kaseya:kaseya /app

USER kaseya

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# MCP_HTTP_HOST=0.0.0.0 is the in-container bind. Startup still refuses to
# run without a real CONDUIT_S2S_SECRET, so this does not expose
# unauthenticated /mcp. MCP_ALLOW_INSECURE_DEV cannot widen the listener
# off 127.0.0.1. AUTH_MODE stays env for existing single-tenant images;
# the Compose gateway service sets AUTH_MODE=gateway and passes no static
# vendor credentials.
ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
# Default to env mode for backward compatibility; set to 'gateway' for hosted deployment
ENV AUTH_MODE=env

CMD ["node", "dist/index.js"]

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

LABEL maintainer="engineering@wyre.ai"
LABEL version="${VERSION}"
LABEL description="Kaseya BMS MCP Server - Model Context Protocol server for Kaseya BMS PSA"
LABEL org.opencontainers.image.title="kaseya-bms-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for Kaseya BMS PSA"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/WYRE-AI/kaseya-bms-mcp"
LABEL org.opencontainers.image.documentation="https://github.com/WYRE-AI/kaseya-bms-mcp/blob/main/README.md"
LABEL org.opencontainers.image.url="https://github.com/WYRE-AI/kaseya-bms-mcp/pkgs/container/kaseya-bms-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/kaseya-bms-mcp"
