# ==============================================================================
# DisruptionIQ Multi-Stage Dockerfile (Bun + React + Embedded PGlite)
# ==============================================================================

# --- Stage 1: Build the React/Vite Frontend ---
FROM oven/bun:1 AS builder
WORKDIR /app

# Cache dependency layer
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Copy source code and build assets
COPY . .
RUN bun run build

# --- Stage 2: Production Runtime ---
FROM oven/bun:1 AS runner
WORKDIR /app

# Install production dependencies only
COPY package.json bun.lock* ./
RUN (bun install --production --frozen-lockfile || bun install --production) && bun pm cache rm

# Copy compiled frontend distribution from builder
COPY --from=builder /app/dist ./dist

# Copy backend server, domain logic, and migrations
COPY src ./src
COPY datasets ./datasets
COPY scripts ./scripts

# Create persistent storage directory for PGlite embedded database
RUN mkdir -p /app/.data/workspace

# Configure default runtime environment
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_MODE=pglite \
    PGLITE_PATH=/app/.data/workspace \
    DEMO_MODE=true \
    DEMO_PASSWORD=disruption-demo \
    APP_ORIGIN=http://127.0.0.1:3000 \
    WEBHOOK_SECRET=local-carrier-demo

EXPOSE 3000

# Persistent volume for PGlite database
VOLUME ["/app/.data"]

# Start integrated production server (serves API and compiled UI)
CMD ["bun", "run", "start"]
