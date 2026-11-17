# chat-lite

个人 AI 对话应用，支持流式聊天、联网搜索、文件分析、图片生成和会话检索。

## 功能

- 账号与会话管理
- SSE 流式对话、联网搜索和网页抓取
- 文件上传、云文件及受限 Bash 沙箱（Python / Go / Java）
- 图片生成、PDF 文本提取与 OCR
- 基于 PostgreSQL 的会话检索

## 技术栈

React 19、TypeScript、Vite、Go 1.26、PostgreSQL、Redis、Kafka、MinIO、Docker。

## 本地开发

需要 Node.js `24.18.x`、Go `1.26` 和 Docker Compose。后端还需配置 PostgreSQL、模型 API；Redis、Kafka、MinIO 用于相应功能。

启动本地数据服务：

```bash
cd go
docker compose up -d
```

在仓库根目录配置 `.env` 后，启动后端：

```bash
cd go
go run ./cmd/server
```

另开终端，在仓库根目录启动前端：

```bash
npm ci
npm run dev
```

前端默认运行于 `5179`，API 请求代理到本机 `3000` 端口。配置模板见 `go/config/config.yaml`；密钥请只放在 `.env`，不要提交到版本库。

## 构建

```bash
npm run typecheck
npm run build
```

## 部署

```bash
bash deploy/build-web.sh
# 首次或升级运行环境时显式制作一次；也可以提前从自己的仓库拉取指定版本
bash deploy/build-runtime-images.sh
# 日常发布只编译业务程序，复用上述环境，不再重建沙箱依赖
bash deploy/rebuild-backend.sh
```

部署脚本会构建前端或后端 Docker 镜像并重建对应服务。后端发布只支持低内存模式：先准备环境镜像和回退信息，再停止主后端与 broker，串行编译后启动新版；构建或健康检查失败时尝试恢复旧版。维护窗口包含编译时间，不承诺执行中的沙箱任务零中断，也不能保证宿主绝不 OOM。生产环境需要预先配置 Compose、`.env`、数据服务及外部 Docker 网络 `shared`。环境镜像制作、指定仓库拉取与双机复用见 [预制运行环境与后端发布](docs/runtime-images.md)。

通用命令沙箱还要求宿主预先启用 ext4 或 XFS project quota；未满足硬配额前置条件时会拒绝执行，不降级为无配额目录。新版执行卡片来自服务端独立记录，旧正文卡片仅作为未验证历史内容兼容。工作区归属、网络与部署边界见 [会话沙箱执行方案](docs/sandbox-execution.md)。

## 目录结构

```text
src/web/   前端
 go/       Go 后端与数据库配置
sandbox/   文件分析沙箱
 deploy/   部署脚本与 Nginx 配置
docs/      项目文档
```
