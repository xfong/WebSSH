FROM node:22-alpine

WORKDIR /app

# Install build dependencies for native modules (ssh2, bcrypt)
RUN apk add --no-cache python3 make g++ openssh-client

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled source (built outside container or via multi-stage)
COPY dist/ ./dist/
COPY certs/ ./certs/

# Install PM2 globally
RUN npm install -g pm2

EXPOSE 3000

CMD ["pm2-runtime", "dist/index.js"]
