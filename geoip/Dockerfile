FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.mjs ./

# mmdb 通过卷挂到 /data（或配置 MaxMind 账号自动下载）
VOLUME ["/data"]
EXPOSE 8090

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:8090/healthz >/dev/null || exit 1

USER node
CMD ["node", "server.mjs"]
