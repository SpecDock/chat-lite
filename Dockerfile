# 前后端仍由同一个容器提供。容器里的进程是 Go：
# 它监听 3000，/api 走接口，其它路径读取 dist 里的前端文件。
# 阶段串成直线，vite 和 go build 不会同时占用内存。
# 默认从 DaoCloud 拉基础镜像，重建脚本失败时会改用 docker.io。

ARG NODE_IMAGE=docker.m.daocloud.io/library/node:24.18.0-bookworm-slim
ARG GO_IMAGE=docker.m.daocloud.io/library/golang:1.26-bookworm
ARG DEBIAN_IMAGE=docker.m.daocloud.io/library/debian:bookworm-slim

########## 1. web ##########
FROM ${NODE_IMAGE} AS web
WORKDIR /app
ARG NODE_HEAP_MB=512

ENV JOBS=1 \
    MAKEFLAGS=-j1 \
    GOMAXPROCS=1 \
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

########## 2. compile ##########
# FROM web：等前端构建结束后才开始编 Go，BuildKit 不能把两段编译并行起来。
FROM ${GO_IMAGE} AS go-toolchain

FROM web AS compile
COPY --from=go-toolchain /usr/local/go /usr/local/go
COPY --from=go-toolchain /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV PATH=/usr/local/go/bin:${PATH} \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    GOPROXY=https://mirrors.aliyun.com/goproxy/,direct \
    GOSUMDB=sum.golang.org \
    GOMAXPROCS=1 \
    GOGC=50 \
    CGO_ENABLED=0
WORKDIR /app/go
RUN go mod download || GOPROXY=https://goproxy.io,direct go mod download || GOPROXY=https://proxy.golang.org,direct go mod download
RUN go build -p 1 -trimpath -ldflags="-s -w" -o /out/chat-lite ./cmd/server

########## 3. runner ##########
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
COPY --from=web /app/dist /app/dist
COPY --from=web /app/go/schema.sql /app/schema.sql
COPY --from=web /app/go/config /app/config
EXPOSE 3000
CMD ["/app/chat-lite"]
