# The organization's server: the gateway, first-run setup, file store and the
# app, in one container. docs/SELF-HOSTING.md.
#
# Nothing about the organization is built in: the server tells the app its
# gateway and sign-in at start-up (/runtime-config.js, stack/app.mjs), and
# everything else is environment variables given to the container. Build
# from the repository root (the app and stack/ both live there):
#
#   docker build -f stack/Dockerfile -t ohsms-server .

# ── 1. The app ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS app
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ── 2. The server ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /srv

COPY stack/package.json stack/package-lock.json stack/
RUN cd stack && npm ci --omit=dev --no-audit --no-fund

# stack/ imports the app's wire format; that file, not its package.
COPY stack/ stack/
COPY src/shared/data/adapters/postgresWire.js src/shared/data/adapters/postgresWire.js
COPY --from=app /src/dist stack/public

# The SQLite database and uploaded files live here; mount a volume on it
# (selfhost/compose.yaml does).
RUN mkdir -p /srv/stack/data/files && chown -R node:node /srv/stack/data
ENV BLOB_DIR=/srv/stack/data/files DATABASE_FILE=/srv/stack/data/ohsms.sqlite
VOLUME ["/srv/stack/data"]

USER node
WORKDIR /srv/stack
EXPOSE 8080
CMD ["node", "main.mjs"]
