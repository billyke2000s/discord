# Node version is pinned (a tested version, not whatever is newest).
# Stage 1: install dependencies. Build tools are here only as a fallback in case the
# prebuilt better-sqlite3 binary can't be downloaded (e.g. an unusual CPU type).
FROM node:22.22.2-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Stage 2: the actual bot image (no build tools, smaller)
FROM node:22.22.2-bookworm-slim
# fonts for the captcha image (@napi-rs/canvas has no built-in fonts)
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
RUN mkdir -p /app/data /app/locks /app/backups && chown node:node /app/data /app/locks /app/backups
USER node
CMD ["node", "src/index.js"]
