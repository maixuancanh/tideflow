FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server
ENV HOST=0.0.0.0 HARBOR_DATA_DIR=/data HARBOR_FEED_DIR=/data/feed HARBOR_SECURE_COOKIE=true
CMD ["node","scripts/start-server.mjs"]
