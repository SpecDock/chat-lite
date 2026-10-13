# syntax=docker/dockerfile:1
#
# 前后端仍由同一个容器提供。容器里的进程换成 Go：
# 它监听 3000，/api 走接口，其它路径读取 dist 里的前端文件。
# 阶段串成直线，vite 和 go build 不会同时占用内存。

########## 1. web ##########
FROM node:24.18.0-bookworm-slim AS web
WORKDIR /app

ENV JOBS=1 \
    MAKEFLAGS=-j1 \
    GOMAXPROCS=1 \
    npm_config_maxsockets=3 \
    npm_config_fund=false \
    npm_config_audit=false \
    NODE_OPTIONS=--max-old-space-size=1024

ARG VITE_STREAM_MARKDOWN_INTERVAL_MS=50
ENV VITE_STREAM_MARKDOWN_INTERVAL_MS=$VITE_STREAM_MARKDOWN_INTERVAL_MS

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --registry=https://registry.npmmirror.com --replace-registry-host=always \
    || npm ci --no-audit --no-fund --registry=https://registry.npmjs.org --replace-registry-host=always

COPY . .
RUN npm run build:web

########## 2. compile ##########
# FROM web：等前端构建结束后才开始编 Go，BuildKit 不能把两段编译并行起来。
FROM web AS compile
COPY --from=golang:1.26-bookworm /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:${PATH} \
    GOPROXY=https://goproxy.cn,direct \
    GOSUMDB=sum.golang.org \
    GOMAXPROCS=1 \
    CGO_ENABLED=0
WORKDIR /app/go
RUN go mod download || GOPROXY=https://proxy.golang.org,direct go mod download
RUN go build -p 1 -trimpath -ldflags="-s -w" -o /out/chat-lite ./cmd/server

########## 3. runner ##########
FROM debian:bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
COPY --from=compile /out/chat-lite /app/chat-lite
COPY --from=web /app/dist /app/dist
COPY --from=web /app/go/schema.sql /app/schema.sql
COPY --from=web /app/go/config /app/config
EXPOSE 3000
CMD ["/app/chat-lite"]
