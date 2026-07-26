# syntax=docker/dockerfile:1
#
# 2 核 2GB 服务器上的构建策略：宁可慢，也要串行、低峰值。
#   - stage 刻意串成一条直线（prod-deps FROM build），BuildKit 无法并发跑
#   - JOBS/MAKEFLAGS/GOMAXPROCS 把 make 和 esbuild(Go) 钉死在单线程
#   - better-sqlite3 走国内预编译二进制，避开现场 g++ 编译 sqlite3.c

########## 1. deps ##########
FROM node:24.18.0-bookworm-slim AS deps
WORKDIR /app

# 单线程开关。后续 stage 通过 FROM 继承，不用重复声明。
#   JOBS / MAKEFLAGS -> node-gyp 调用的 make
#   GOMAXPROCS       -> esbuild 是 Go 二进制，默认吃满所有核
#   maxsockets       -> npm 并发下载解压（默认 15）
ENV JOBS=1 \
    MAKEFLAGS=-j1 \
    GOMAXPROCS=1 \
    npm_config_maxsockets=3 \
    npm_config_fund=false \
    npm_config_audit=false \
    NODE_OPTIONS=--max-old-space-size=1024

# better-sqlite3 的 install 是 `prebuild-install || node-gyp rebuild`，
# 而 prebuild-install 走 GitHub Releases，不受上面 --registry 影响。
# 变量名规则见 prebuild-install/util.js:
#   'npm_config_' + pkg.name.replace(/[^a-zA-Z0-9]/g, '_')  + '_binary_host_mirror'
# 拼出的 URL: <mirror>/v{version}/{name}-v{version}-node-v{abi}-linux-x64.tar.gz
ENV npm_config_better_sqlite3_binary_host_mirror=https://cdn.npmmirror.com/binaries/better-sqlite3

# python3/make/g++ 是下载失败时的兜底路径，不要删。
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --no-audit --no-fund --registry=https://registry.npmmirror.com --replace-registry-host=always \
    || npm ci --no-audit --no-fund --registry=https://registry.npmjs.org --replace-registry-host=always

########## 2. build ##########
# FROM deps 而不是「新基底 + COPY --from=deps node_modules」：
# 省掉 294MB 的跨 stage 拷贝。node_modules 已在 .dockerignore 里，COPY . . 不会覆盖它。
FROM deps AS build
ARG VITE_STREAM_MARKDOWN_INTERVAL_MS=50
ENV VITE_STREAM_MARKDOWN_INTERVAL_MS=$VITE_STREAM_MARKDOWN_INTERVAL_MS
COPY . .
# 拆两层不是为了省内存（&& 本来就串行，峰值是 max 不是 sum），
# 而是为了缓存粒度，以及构建失败时能一眼看出是前端还是后端挂的。
RUN npm run build:web
RUN npm run build:server

########## 3. prod-deps ##########
# 关键：FROM build，不是 FROM deps。
# 原来 prod-deps 和 build 都只依赖 deps，是 DAG 上两个独立分支，
# BuildKit 会并发执行 —— npm prune 撞上峰值 565MB 的 vite build。
# 串成直线后想并行也没得并。
FROM build AS prod-deps
RUN npm prune --omit=dev --no-audit --no-fund \
    && rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src \
    && npm cache clean --force

########## 4. runner ##########
FROM node:24.18.0-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# uv/uvx 是 web_search 依赖的 MiniMax MCP 运行时，不要删
COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /uvx /usr/local/bin/
RUN uv --version && uvx --version
COPY package*.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/dist ./dist
COPY --from=prod-deps /app/dist-server ./dist-server
COPY --from=prod-deps /app/src/server/schema.sql ./src/server/schema.sql
EXPOSE 3000
# 直接 exec node，不经 npm：少一个常驻 npm 进程，PID1 也能正常收到 SIGTERM
CMD ["node", "dist-server/index.js"]
