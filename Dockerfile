# 远拓运营中心 · 容器镜像
# 用于腾讯云开发「云托管」(CloudBase Run) 部署
FROM node:22-alpine

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package.json ./
RUN npm install --production

# 复制代码与前端构建产物
COPY server.js ./
COPY .env.example ./.env.example
COPY dist ./dist

# 云托管会通过环境变量 PORT 告知监听端口，server.js 已支持 process.env.PORT
EXPOSE 3000

CMD ["node", "server.js"]
