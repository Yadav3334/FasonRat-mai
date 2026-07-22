# FasonRat Server
# Usage: docker run -d -p 32766:32766 -v fasonrat-data:/app/backend/data fahimahamed/fasonrat:latest

# Stage 1: Build frontend
FROM node:22-slim AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund --legacy-peer-deps \
    && npm install --no-audit --no-fund @rolldown/binding-linux-x64-gnu || true
COPY frontend/ ./
RUN npm run build

# Stage 2: Compile backend TypeScript
FROM node:22-slim AS backend-build

WORKDIR /app/backend
COPY backend/package.json ./
RUN npm install --no-audit --no-fund
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

# Stage 3: Install backend production dependencies only
FROM node:22-slim AS backend-deps

WORKDIR /app/backend
COPY backend/package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Stage 4: Final image
FROM node:22-slim

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
        openjdk-17-jre-headless \
        wget \
        tini \
        gosu \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 app \
    && useradd --system --uid 1001 --gid 1001 --create-home app

WORKDIR /app

COPY --from=backend-build /app/backend/dist ./backend/dist
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY backend/package.json ./backend/

COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# APK builder factory files
COPY backend/app ./backend/app

RUN mkdir -p /app/backend/data \
    && chown -R app:app /app

COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 32766

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --spider -q http://localhost:32766/api/health || exit 1

CMD ["node", "backend/dist/index.js"]
