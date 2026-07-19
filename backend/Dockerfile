# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install native build tools required by ssh2 and bcrypt
RUN apk add --no-cache python3 make g++

# Install all dependencies (including devDependencies for TypeScript compiler)
COPY package*.json ./
RUN npm ci

# Copy source and compile TypeScript → dist/
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

# Install native build tools needed at runtime by ssh2 and bcrypt
RUN apk add --no-cache python3 make g++ openssh-client

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist/

# Create certs directory; the LDAP CA cert is mounted here at runtime via
# docker-compose volume (docker/nginx/ssl/ldap-ca.crt → /app/certs/ldap-ca.crt)
RUN mkdir -p /app/certs

# Install PM2 globally for process management
RUN npm install -g pm2

EXPOSE 3000

CMD ["pm2-runtime", "dist/index.js"]
