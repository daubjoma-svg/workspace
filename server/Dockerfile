FROM node:22-bookworm-slim AS web-build

WORKDIR /app
COPY web/package*.json ./web/
RUN cd web && npm ci

# 前端源码会直接引用仓库根目录的 design-system，必须与 web 一起进入构建阶段。
COPY web/ ./web/
COPY design-system/ ./design-system/
RUN cd web && npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOME=/home/node \
    TRAECLI_BIN=/usr/local/bin/traecli \
    TRAE_HOME=/home/node/.trae

WORKDIR /app/server

# 国内服务器访问 Debian 官方源较慢，构建时切换到阿里云镜像以降低超时风险。
# 仓库同步优先走 GitLab archive，失败时会回退到 git clone；tar 用于解压仓库快照。
COPY server/package*.json ./
RUN sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git tar python3 make g++ \
    && npm ci --omit=dev \
    && npm cache clean --force \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 固定官方安装脚本与 CLI 版本；安装器按架构选择发行包并校验大小和 SHA256。
# 二进制放在镜像内，授权目录单独持久化，避免升级覆盖登录状态或把令牌写入镜像。
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl python3 \
    && curl -fsSL --connect-timeout 15 --max-time 120 --retry 2 \
       https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/install_v2.sh \
       -o /tmp/traecli-install.sh \
    && echo 'd86c84066bb493d40f6d671733b6243dddb9c39df1a9084676470736548b5be8  /tmp/traecli-install.sh' | sha256sum -c - \
    && TRAECLI_CHANNEL=tob TRAECLI_VERSION=0.207.1-tob \
       TRAECLI_INSTALL_DIR=/usr/local/bin TRAECLI_STATE_DIR=/opt/traecli \
       TRAECLI_INSTALL_ASSUME_YES=1 TRAECLI_INSTALL_MIGRATE_BREW=0 \
       TRAECLI_INSTALL_REMOVE_COCO=0 TRAECLI_REQUIRE_RG=1 TRAECLI_REQUIRE_BWRAP=1 \
       sh /tmp/traecli-install.sh \
    && traecli --version \
    # 安装器以 root 创建 700 的 release 目录，运行时用户 node 需要读取其中的 CLI。
    && chmod -R a+rX /opt/traecli \
    && apt-get purge -y --auto-remove python3 \
    && rm -rf /var/lib/apt/lists/* /tmp/traecli-install.sh

COPY --chown=node:node server/ ./
COPY --from=web-build --chown=node:node /app/web/dist /app/web/dist

# 运行数据由 Compose 数据卷持久化；预先创建目录保证非 root 用户拥有写权限。
RUN mkdir -p /app/server/data/repos /app/server/uploads /home/node/.trae \
    && chmod 700 /home/node/.trae \
    && chown -R node:node /app/server/data /app/server/uploads /home/node/.trae

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then((res)=>{if(!res.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
