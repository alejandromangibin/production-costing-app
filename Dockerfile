# Production Costing, hosted version. Build:  docker build -t production-costing .
# Run (needs a PostgreSQL DATABASE_URL, see DEPLOY.md):
#   docker run -p 3001:3001 --env-file .env.production production-costing

# Pinned to an exact Node version so the Node version cannot change on its own (the image still gets OS updates); updating Node is a deliberate step (check, test, then change this line).
FROM node:22.23.4-slim
WORKDIR /app
ENV NODE_ENV=production

# Install everything, build the web screens, then keep only what the server needs.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --include=dev

COPY server server
COPY web web
RUN npm run build && npm prune --omit=dev

# Listen on all addresses inside the container; the host's HTTPS proxy sits in front.
ENV HOST=0.0.0.0 PORT=3001
EXPOSE 3001
USER node
WORKDIR /app/server
CMD ["npx", "tsx", "src/index.ts"]
