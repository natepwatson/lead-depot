# Lead Depot — pre-built dist approach
# dist/ is committed to git, so we skip the npm run build step entirely.
# This bypasses Railway's railpack builder which is currently broken (July 4 2026).

FROM node:22-slim

WORKDIR /app

# Install only production native deps (better-sqlite3 needs node-gyp tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first for layer caching
COPY package*.json ./

# Install all deps (needed for better-sqlite3 native bindings)
RUN npm ci --include=optional 2>&1 | tail -5

# Copy the rest of the app (including pre-built dist/)
COPY . .

# Expose port
EXPOSE 5000

# Start using the pre-built bundle
CMD ["node", "dist/index.cjs"]
