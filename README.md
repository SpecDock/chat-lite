# Chat Lite

轻量手机端 Chat Web 应用：React/Vite 前端 + Node.js 原生 HTTP TypeScript 后端 + SQLite + LangChain 单模型智能体 + MCP 工具 + 文/图生图 + RAG 长期记忆。

面向 5 人私用场景，单 Node 进程，单 SQLite 文件，单机部署，零外部依赖。

## 当前架构

```text
Browser (React + Vite + TypeScript)
  ↓
Node.js 原生 HTTP API + 小型 TypeScript Router
  ├─ Auth: 邮箱密码 + 邮箱验证码 + 邀请码
  ├─ Session: HttpOnly Cookie + SQLite token hash
  ├─ Data: SQLite (app.db)
  ├─ Uploads: 本地 uploads，鉴权访问
  ├─ RAG: SQLite (rag.db) + sqlite-vec，向量检索
  ├─ Image Gen: aicodelink / ColorFlow OpenAI-compatible
  └─ Agent: LangChain createAgent
       ├─ ChatOpenAI (OpenAI-compatible baseURL)
       ├─ Task Router (deepseek-v4-flash，识别意图)
       ├─ Workflows (chat / web_search / vision_qa / text_to_image / image_edit)
       └─ MCP tools
            ├─ web_search
            └─ understand_image
```

## 技术栈

| 维度 | 选型 |
| --- | --- |
| 前端 | React + Vite + TypeScript + markdown-it + DOMPurify + GSAP |
| 后端 | Node.js (≥ 22) + 原生 `node:http` + TypeScript + esbuild |
| 数据库 | SQLite + better-sqlite3 |
| 向量库 | sqlite-vec（独立 rag.db，与 app.db 分离） |
| 认证 | argon2id + HttpOnly Cookie Session |
| 智能体 | LangChain.js `createAgent` + `ChatOpenAI` |
| 路由 | 自建轻量 Router + 业务模块化（DDD 风格） |
| MCP | `@modelcontextprotocol/sdk` stdio client |
| 图片 | OpenAI 兼容 `/images/generations` + `/images/edits` (b64_json / url) |
| 嵌入 | OpenAI 兼容 `/embeddings` (Qwen3-Embedding-0.6B, 1024 维) |
| 部署 | Docker Compose + Nginx + Let's Encrypt |

## 目录结构

```text
chat-lite/
├─ src/
│  ├─ server/                  # 后端
│  │  ├─ core/                 # db / http / security / mail 等基础
│  │  ├─ modules/
│  │  │  ├─ auth/              # 登录注册、邀请码、邮箱验证
│  │  │  ├─ chat/              # workflows + tools + image-selection
│  │  │  ├─ images/            # 文生图、图生图、MiniMax
│  │  │  ├─ uploads/           # 附件上传、签名 URL
│  │  │  ├─ rag/               # rag.db + sqlite-vec + chunker
│  │  │  ├─ usage/             # token_usage / image_usage
│  │  │  └─ events/            # SSE 跨设备实时同步
│  │  ├─ modules/chat/workflows/  # chat / web_search / vision_qa / text_to_image / image_edit
│  │  └─ index.ts              # 入口
│  └─ web/                     # 前端 React
│     ├─ features/chat/        # MessageList / MessageActions / MessageInput
│     ├─ features/messages/    # MarkdownMessage (markdown-it)
│     ├─ features/auth/        # Login / Register / ProfileMenu
│     └─ App.tsx
├─ scripts/                    # 部署/运维脚本
├─ test/                       # 测试脚本（独立 node .mjs）
├─ deploy/                     # Docker / Nginx / Certbot 配置
├─ data/                       # app.db + rag.db + uploads（本地）
├─ Dockerfile
├─ docker-compose.prod.yml
└─ .env.example
```

## 本地运行

```powershell
cd D:\chat-lite
Copy-Item .env.example .env
# 编辑 .env 填入 API key 和邀请码
npm install
npm run dev:server
```

另开一个终端：

```powershell
cd D:\chat-lite
npm run dev
```

打开 `http://localhost:5173`。

## 必填配置（.env）

### 基础

```env
INVITE_CODE=your-private-invite-code
SESSION_SECRET=...
NODE_ENV=production
APP_ORIGIN=https://chat.zzxandyl.cn
```

### 主模型（OpenAI 兼容）

```env
MODEL_API_KEY=...
MODEL_BASE_URL=https://your-endpoint/v1
MODEL_NAME=your-model
MODEL_MAX_ATTEMPTS=2
```

### 路由模型

```env
TITLE_API_KEY=...
TITLE_BASE_URL=https://your-endpoint/v1
TITLE_MODEL_NAME=deepseek-v4-flash
TITLE_MODEL_TEMPERATURE=0.2
```

### 邮件（注册验证码）

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=...
SMTP_PASS=...              # Gmail 应用专用密码
SMTP_FROM=Chat Lite <...>
SMTP_TLS_SERVERNAME=smtp.gmail.com
```

### 文生图

```env
TEXT_IMAGE_API_URL=https://aicodelink.top/v1/images/generations
TEXT_IMAGE_API_KEY=...
TEXT_IMAGE_MODEL=gpt-image-2
TEXT_IMAGE_SIZE=auto
TEXT_IMAGE_QUALITY=low
TEXT_IMAGE_RESPONSE_FORMAT=b64_json
TEXT_IMAGE_MAX_BATCH=10
TEXT_IMAGE_DEFAULT_BATCH=1
TEXT_IMAGE_MAX_PARALLEL=4
```

### 图生图

```env
IMAGE_EDIT_API_URL=https://aicodelink.top/v1/images/edits
IMAGE_EDIT_API_KEY=...
IMAGE_EDIT_MODEL=gpt-image-2
IMAGE_EDIT_SIZE=auto
IMAGE_EDIT_QUALITY=low
IMAGE_EDIT_SOURCE_MODE=multipart
IMAGE_EDIT_RESPONSE_FORMAT=b64_json
```

### MiniMax MCP

```env
MINIMAX_API_KEY=...
MINIMAX_API_HOST=https://api.minimaxi.com
MINIMAX_MCP_COMMAND=uvx
MINIMAX_MCP_ARGS=minimax-coding-plan-mcp -y
MINIMAX_MCP_BASE_PATH=./data
```

### RAG

```env
RAG_WRITE_ENABLED=true
RAG_READ_ENABLED=true
RAG_SHADOW_ENABLED=false
RAG_TOP_K=3
RAG_MAX_DISTANCE=0.4
RAG_CONTENT_MAX_CHARS=1200
RAG_CHUNK_ENABLED=true
RAG_CHUNK_MAX_CHARS=1200
RAG_DATABASE_PATH=./data/rag.db

EMBEDDING_API_KEY=...
EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
EMBEDDING_DIMENSIONS=1024

RAG_CHUNK_MODEL_API_KEY=...
RAG_CHUNK_MODEL_BASE_URL=...
RAG_CHUNK_MODEL_NAME=deepseek-v4-flash
RAG_CHUNK_MODEL_TEMPERATURE=0

RAG_BACKFILL_BATCH_SIZE=20
RAG_BACKFILL_DELAY_MS=1000
```

### Agent 工具调用上限

```env
AGENT_MAX_TOOL_CALLS=16
AGENT_MAX_IMAGE_GENERATION_CALLS=10
AGENT_MAX_IMAGE_TO_IMAGE_CALLS=10
AGENT_RECURSION_LIMIT=30
```

### 上下文窗口

```env
ANSWER_HISTORY_LIMIT=20
```

## 核心功能

### 1. 单模型智能体

`createAgent` + `ChatOpenAI`，模型走 OpenAI 兼容协议。

工具集：

```text
web_search        → MCP web_search
understand_image  → MCP understand_image（多模态识别）
generate_image    → 文生图
image_to_image    → 图生图
```

### 2. 任务路由

`task-router.ts` 用轻量 LLM（deepseek-v4-flash）识别意图：

```text
chat / web_search / vision_qa / text_to_image / image_edit
```

含当前会话优先规则：

```text
带图 + wantsEdit (加爱心/重绘/...)  → image_edit
带图                                → vision_qa
不带图 + 画图关键词                 → text_to_image
不带图 + 搜索关键词                 → web_search
其他                                → chat
```

### 3. Workflows

| Workflow | 触发 | 说明 |
| --- | --- | --- |
| chat | 普通对话 | RAG 上下文 + 主 AI |
| web_search | 搜索 | web_search 工具 + 主 AI |
| vision_qa | 带图识别 | 主 AI 多模态 |
| text_to_image | 文生图 | 主 AI 优化 prompt + 上游生图 |
| image_edit | 图生图 | 主 AI 优化 prompt + 源图 + 上游编辑 |

主 AI 在 t2i/i2i 链路上作为 **prompt 优化器**，把用户简短请求改写为图像模型友好的详细描述。

### 4. 文/图生图

`/api/chat` 走主流程，由 router 决定。`image-generation.service.ts` 调上游：

```text
TEXT_IMAGE_API_URL  (POST JSON)
IMAGE_EDIT_API_URL  (POST multipart)
```

`size=auto` 时不发送 size 字段，由上游决定。

### 5. RAG 长期记忆

- 独立 `rag.db`，与 app.db 分离
- per-conversation 隔离：检索只看当前会话 chunk
- 写时异步（不阻塞聊天）
- 距离阈值过滤：超过 `RAG_MAX_DISTANCE=0.4` 不召回
- `currentConversationBoost` 已弃用（per-conversation 后无意义）
- 语义切块：`RAG_CHUNK_MODEL`；短文本 fallback 简单切块

### 6. SSE 跨设备实时同步

`/api/events` 推送给同账号的多个设备：

```text
messages_changed
conversations_changed
conversation_deleted
```

后端用内存 `Map<userId, Set<Response>>` 维护连接。

### 7. 流式 think 块

assistant 回复带 `<think>...</think>` 过程块：

```text
[思考过程]  ← 可折叠，默认收起
[正文]
```

前端支持手动展开/折叠。

### 8. 取消传播

`AbortSignal` 一路透传到 `fetch`：

```text
chat.ts → workflow → tool → service → fetch(..., { signal })
```

用户停止时立即断开上游连接。

### 9. 复制按钮

每条消息下方常驻 GSAP 淡入的复制按钮，移动端大点击区。

## 验证

```powershell
npm run typecheck
npm run build
```

## 生产部署

### 一键部署流程

1. 服务器初始化 swap（避免 Docker build OOM）
2. clone 仓库到 `/data/chat-lite/chat-lite`
3. 配置 `.env`
4. 申请 Let's Encrypt 证书
5. `bash deploy/rebuild-chat-lite.sh`

### 部署脚本

```text
deploy/
├─ rebuild-chat-lite.sh    # 重建容器
├─ install-uvx-runtime.sh  # 容器重建后补装 uvx
├─ nginx/conf.d/           # HTTPS 配置
└─ certbot/                # 证书挂载
```

### 部署路径

```text
/data/chat-lite/chat-lite/
├─ data/        # app.db + rag.db + uploads
├─ deploy/      # nginx / certbot 配置
├─ .env         # 私有配置
├─ docker-compose.prod.yml
└─ Dockerfile
```

宿主机不保留 `node_modules`、`dist` 等构件，全在容器内。

## 运维脚本

```bash
# 重建并启动
bash deploy/rebuild-chat-lite.sh

# 容器重建后补装 uvx
bash deploy/install-uvx-runtime.sh

# 历史消息向量入库
docker compose -f docker-compose.prod.yml exec chat-lite npm run rag:backfill

# 清理低频 RAG chunk（dry-run）
bash scripts/prune-rag.sh

# 重建 rag.db（per-conversation 隔离改造后）
docker compose -f docker-compose.prod.yml stop chat-lite
rm -f data/rag.db data/rag.db-wal data/rag.db-shm
docker compose -f docker-compose.prod.yml up -d chat-lite

# 查每用户 token / 图片统计
bash scripts/usage-report.sh
```

## 数据隔离

- 每条业务数据带 `user_id`（user-based）
- RAG chunk 带 `conversation_id`（per-conversation 隔离）
- 删除会话 → 消息/附件/RAG 全部级联清理
- 上传文件按 `user_id` 子目录存放

## 安全

- 前端从不传 `user_id`，从 session cookie 推导
- 业务 SQL 全部带 `user_id` / `conversation_id` 过滤
- session token 浏览器保存原文，DB 只存 hash
- 上传文件 MIME/大小限制、文件名随机
- Markdown 用 DOMPurify 清洗
- API Key 只在服务端 `.env`
- HttpOnly + SameSite cookie
- Invitation code 私用注册
- Gmail SMTP 16 位应用专用密码
- AbortSignal 透传，前端停止即断开上游

## 限制

- 5 人私用设计，不要外网公开放
- LangChain MCP stdio 通信，开销在工具调用上
- 图像生成单图 30-150s（受上游影响）
- RAG 不跨对话共享（per-conversation 设计）
- 单机部署，不支持水平扩展

## License

Private / Proprietary.
