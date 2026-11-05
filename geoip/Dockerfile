FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.mjs ./

# 启动时自动从 GitHub 下载 GeoLite2 库到 /data；提前建目录并交给 node 用户
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8090

# 首次启动要下载约 55MB 的数据库，宽限期放长一些
HEALTHCHECK --interval=60s --timeout=5s --start-period=300s \
  CMD wget -qO- http://127.0.0.1:8090/healthz >/dev/null || exit 1

USER node
CMD ["node", "server.mjs"]
