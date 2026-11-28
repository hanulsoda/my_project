# Reading eye tracker app. The Caddy container in docker-compose.yml terminates https in front of it.
FROM node:22-slim

ENV NODE_ENV=production
# Default to the volume mount so a hand-written .env without DB_PATH cannot put the database in the
# container layer (lost on `up --build`). .env / compose may still override it.
ENV DB_PATH=/app/data/db/app.db
WORKDIR /app

# better-sqlite3 13 ships prebuilt binaries inside its npm package (linux x64 and arm64, glibc),
# but npm would still try `node-gyp rebuild` because the package has a binding.gyp, and the slim
# image has no compiler or python. --ignore-scripts skips that and uses the shipped binary
# (express has no install scripts, so nothing else is skipped).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server ./server
COPY public ./public
# passages.json is code (the passage set), not user data: it lives in the image. The SQLite
# volume is mounted one level deeper (/app/data/db) so it never shadows this file.
COPY data/passages.json ./data/passages.json

# Owned by the non-root user so a fresh named volume mounted here is writable.
RUN mkdir -p /app/data/db && chown -R node:node /app/data
USER node

# Listens on 0.0.0.0:3000 inside the container. Not published to the host (see docker-compose.yml).
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/index.html').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "server/index.js"]
