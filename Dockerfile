# 前端和后端分开构建。
# docker build --target web 只产出页面，由 deploy/build-web.sh 拷到 Nginx 目录。
# 不指定 target 时只构建 Go 后端，镜像里不再包含 dist。

ARG NODE_IMAGE=docker.m.daocloud.io/library/node:24.18.0-bookworm-slim
ARG GO_IMAGE=docker.m.daocloud.io/library/golang:1.26-bookworm
ARG DEBIAN_IMAGE=docker.m.daocloud.io/library/debian:bookworm-slim

########## web ##########
FROM ${NODE_IMAGE} AS web
WORKDIR /app
ARG NODE_HEAP_MB=512

ENV JOBS=1 \
    MAKEFLAGS=-j1 \
    npm_config_maxsockets=3 \
    npm_config_fund=false \
    npm_config_audit=false \
    NODE_OPTIONS=--max-old-space-size=${NODE_HEAP_MB}

ARG VITE_STREAM_MARKDOWN_INTERVAL_MS=50
ENV VITE_STREAM_MARKDOWN_INTERVAL_MS=$VITE_STREAM_MARKDOWN_INTERVAL_MS

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --registry=https://registry.npmmirror.com --replace-registry-host=always \
    || npm ci --no-audit --no-fund --registry=https://registry.npmjs.org --replace-registry-host=always

COPY . .
RUN npm run build:web

########## backend ##########
FROM ${GO_IMAGE} AS compile
WORKDIR /src
ARG GO_MEM_LIMIT_MB=384
ENV GOPROXY=https://mirrors.aliyun.com/goproxy/,direct \
    GOSUMDB=sum.golang.org \
    GOMAXPROCS=1 \
    GOGC=50 \
    GOMEMLIMIT=${GO_MEM_LIMIT_MB}MiB \
    CGO_ENABLED=0

COPY go/go.mod go/go.sum ./
RUN go mod download || GOPROXY=https://goproxy.io,direct go mod download || GOPROXY=https://proxy.golang.org,direct go mod download
COPY go/ ./
RUN go build -p 1 -trimpath -ldflags="-s -w" -o /out/chat-lite ./cmd/server

########## runner ##########
FROM ${DEBIAN_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget poppler-utils python3 python3-pip \
    && (python3 -m pip install --no-cache-dir --break-system-packages -i https://mirrors.aliyun.com/pypi/simple --trusted-host mirrors.aliyun.com pdfplumber \
        || python3 -m pip install --no-cache-dir --break-system-packages pdfplumber) \
    && rm -rf /var/lib/apt/lists/*
COPY --from=compile /out/chat-lite /app/chat-lite
COPY go/schema.sql /app/schema.sql
COPY go/config /app/config
EXPOSE 3000
CMD ["/app/chat-lite"]
