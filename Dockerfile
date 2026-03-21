# 使用 Node.js 官方镜像作为基础镜像
FROM node:22-slim

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json (如果存在)
COPY package*.json ./

# 安装依赖
RUN npm install

# 复制所有源代码
COPY . .

# 构建前端静态文件
RUN npm run build

# 设置环境变量为生产模式
ENV NODE_ENV=production

# 暴露端口 3000
EXPOSE 3000

# 启动服务器
CMD ["npm", "run", "start"]
