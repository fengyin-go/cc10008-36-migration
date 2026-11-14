# production 构建：迁移基准必须在构建时注入，不回退到开发默认值。
# VITE_SHARE_MIGRATION_BASELINE 由部署环境传入（docker-compose / CI），
# 未传时 build 会直接失败，避免正式凭证使用错误基准。
ARG VITE_SHARE_MIGRATION_BASELINE
FROM node:20-alpine AS build
WORKDIR /srv/web
COPY package.json ./
RUN npm install
COPY . .
ARG VITE_SHARE_MIGRATION_BASELINE
ENV VITE_SHARE_MIGRATION_BASELINE=${VITE_SHARE_MIGRATION_BASELINE}
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /srv/web
RUN npm install -g serve@14
COPY --from=build /srv/web/dist ./dist
EXPOSE 4173
CMD ["serve", "-s", "dist", "-l", "4173"]
