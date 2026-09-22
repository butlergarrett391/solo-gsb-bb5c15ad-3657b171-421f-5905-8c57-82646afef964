# 小型印刷店小册子拼版应用
# 依赖在镜像构建阶段完成安装，容器启动即可用
FROM node:20-alpine

WORKDIR /app

# 优先复制依赖清单，利用层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 复制应用代码
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    MAX_UPLOAD_MB=50 \
    JOB_TTL_MINUTES=30 \
    MAX_JOBS=20

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
