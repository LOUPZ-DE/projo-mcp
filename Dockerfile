# syntax=docker/dockerfile:1

# Playwright-Version MUSS zu "playwright" in package.json passen (Browser-Build ↔ Client-Protokoll).
# Der Build bricht ab, wenn beide auseinanderlaufen.
ARG PLAYWRIGHT_VERSION=1.64.1

# ── Stage 1: Dependencies ────────────────────────────────────────────────────
# Debian statt Alpine: Playwrights Chromium läuft nicht auf musl.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: Build (TypeScript → dist) + Produktions-Dependencies ───────────
FROM deps AS build
ARG PLAYWRIGHT_VERSION
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev
RUN test "$(node -p "require('playwright/package.json').version")" = "${PLAYWRIGHT_VERSION}" \
 || (echo "playwright in package.json passt nicht zu PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}" >&2 && exit 1)

# ── Stage 3: Runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ARG PLAYWRIGHT_VERSION
ENV NODE_ENV=production \
    TZ=Europe/Berlin \
    DATA_DIR=/data \
    STATE_FILE=/data/state.json \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

# Chromium + System-Abhängigkeiten (Fonts, NSS …) exakt für diese Playwright-Version; dazu tini + tzdata.
# Chromium wird nur für den Microsoft-Login und das Training gebraucht – normale Tool-Calls laufen per HTTP.
RUN npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
 && apt-get update \
 && apt-get install -y --no-install-recommends tini tzdata \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY assets/ assets/

# Datenverzeichnis (OAuth-State, verschlüsselter Sitzungs-Tresor, Audit-Log) → als Volume mounten.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reapt Chromium-Kindprozesse; -s funktioniert auch, wenn die Plattform selbst ein init als PID 1 stellt.
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "dist/index.js"]
