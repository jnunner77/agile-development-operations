# syntax=docker/dockerfile:1

# ---- Build the web client -----------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Runtime ------------------------------------------------------------------
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/data
# The server uses only Node's built-in modules: nothing to install. package.json is still needed
# for its "imports" map (#domain/…, #application/…).
COPY package.json ./
COPY src ./src
COPY --from=build /app/dist/client ./dist/client
# The data directory is owned by the unprivileged user so a fresh volume inherits it.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# Node 22.18+ runs TypeScript directly by stripping the types; no build step or loader.
CMD ["node", "src/main.ts"]
