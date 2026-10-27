# syntax=docker/dockerfile:1

# ── Stage 1: Dependencies ────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: Build (TypeScript → dist) + Produktions-Dependencies ───────────
FROM deps AS build
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev

# ── Stage 3: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY assets/ assets/

# Datenverzeichnis für das Statefile (STATE_FILE=/data/state.json).
# Auf EasyPanel hier ein Volume mounten, damit DCR-Clients + Refresh-Tokens
# Redeploys überstehen.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]
