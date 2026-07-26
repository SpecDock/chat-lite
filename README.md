# Chat Lite

面向少量用户私用的轻量 Chat Web 应用：React/Vite 前端、Node.js 原生 HTTP TypeScript 后端、SQLite 数据层、手写两阶段 ReAct AgentLoop、可插拔工具与当前会话隔离的 RAG 长期记忆。

应用按单 Node 进程、单机部署设计。业务数据使用 `app.db`，RAG 使用独立 `rag.db`，上传文件保存在本地 `data/uploads`；模型、嵌入、图片和搜索能力通过配置的外部服务提供。

## 当前架构

```text
Browser
  ├─ React 19 + Vite + TypeScript
  ├─ markdown-it + DOMPurify
  ├─ Shiki Oniguruma 流式代码高亮（按需加载）
  └─ GSAP
       ↓ HTTP / SSE
Node.js 24 原生 HTTP API
  ├─ Auth: 邮箱密码 + 邮箱验证码 + 邀请码
  ├─ Session: HttpOnly Cookie + SQLite token hash
  ├─ Data: better-sqlite3 (app.db)
  ├─ Uploads: 本地文件 + 鉴权访问
  ├─ Events: 同账号多设备 SSE
  ├─ RAG: rag.db + sqlite-vec + FTS5 + RRF + dedup
  ├─ Image: OpenAI-compatible generations / edits
  └─ AgentLoop
       ├─ ChatOpenAI.bindTools
       ├─ ToolRegistry
       ├─ 工具决策轮（可多轮调用工具）
       └─ 最终回答轮（tool_choice: none，流式输出）
```

## 版本与技术栈

| 维度 | 当前选型 |
| --- | --- |
| 运行时 | Node.js 24.18.0，`engines: >=24.18.0 <25` |
| 前端 | React 19.2.8 / ReactDOM 19.2.8 + Vite + TypeScript + GSAP |
| Markdown | markdown-it + DOMPurify；数学按普通文本和 Unicode 呈现 |
| 代码高亮 | Shiki 4.3.1 + `@shikijs/stream` 4.3.1 + Oniguruma WASM |
| 后端 | 原生 `node:http` + TypeScript + esbuild |
| 数据库 | better-sqlite3 12.11.1 |
| 密码 | argon2 0.45.1（argon2id） |
| RAG | sqlite-vec 0.1.9 + SQLite FTS5，独立 `rag.db` |
| 智能体 | 手写两阶段 ReAct AgentLoop + `ChatOpenAI.bindTools` + ToolRegistry |
| MCP | `@modelcontextprotocol/sdk` stdio client，用于 `web_search` |
| 图片 | OpenAI 兼容 `/images/generations` 与 `/images/edits` |
| 嵌入 | OpenAI 兼容 `/embeddings`，默认 Qwen3-Embedding-0.6B / 1024 维 |
| 部署 | Docker / Docker Compose，容器同样固定 Node.js 24.18.0 |

### 流式代码高亮

- 完整累计正文先由纯函数 parser 识别零缩进的顶层 CommonMark fenced code；列表、引用和其他嵌套 Markdown 继续交给 markdown-it。
- 使用 `ShikiStreamTokenizer` 增量分词，并按 recall 语义合并稳定和不稳定 token；React 更新按 animation frame 合并。
- 支持 Shiki 200+ 语言，grammar 按语言动态加载并缓存；主题名为 `chat-lite-typora-light`（Typora 风格浅色主题）。
- Shiki core、Oniguruma、WASM、stream tokenizer 和语言 grammar 均不进入普通消息主 bundle，首次遇到可高亮代码块时才加载。
- 代码超过 100KB（按 UTF-8 bytes）时降级为纯文本；恰好 100KB 仍允许高亮。
- 缺少 `TransformStream` 或 WebAssembly 的旧 WebView，以及 WASM/语言加载失败场景，均显示可复制、可下载的纯文本代码，不阻断消息渲染。
- 数学定界符不会触发专用渲染，数学内容按普通 Markdown 文本或 Unicode 字符显示。

## AgentLoop 与工具

后端不依赖预制智能体编排器。`engine/agent-loop.ts` 手写维护消息、工具调用、ToolMessage、预算、重试、取消和流事件；模型由 `ChatOpenAI` 创建，工具定义由 `ToolRegistry` 转换成 OpenAI function-calling schema。

### 两阶段执行

1. **工具决策阶段**：`ChatOpenAI.bindTools(tools)` 运行一个或多个 decision rounds。模型只决定调用工具或结束决策；工具结果写回 ToolMessage 后可进入下一轮。
2. **最终回答阶段**：决策结束后重新绑定同一工具集并设置 `tool_choice: none`，追加最终回答指令，只流式输出用户可见正文。

每个模型阶段由 `model-retry.ts` 处理可重试错误和中止信号。工具总次数、图片工具次数和递归步数受 `.env` 预算限制。

### 显式 Prompt Cache

主模型请求保持相同且有序的工具 schema，并按“稳定 System → RAG → 有效历史 → 当前用户文字/图片 → 本轮工具轨迹”组织上下文。出站 Chat Completions 请求设置两个显式缓存断点：第一个位于稳定 System 文本末尾，第二个位于当前用户消息末尾，使多轮工具决策和最终回答在不删减上下文的前提下复用公共前缀。

`prompt_cache_key` 由模型名、稳定 System 和有序工具 schema 生成，不包含 RAG、历史、用户消息或随机 ID。若兼容端明确拒绝缓存字段，本次 Agent 运行会自动使用原始请求重试一次；普通 400、限流、服务端错误、取消和已开始的流不会触发该降级，也不会重试工具。

`token_usage` 以每条聊天汇总记录 `cache_measured_prompt_tokens` 与 `cached_tokens`。旧记录保持 `NULL`，新请求的真实未命中记录为 `0`；缓存率只使用实际返回缓存统计的主 Agent 调用计算，即 `cached_tokens / cache_measured_prompt_tokens`。标题、RAG 切分和 embedding 不纳入缓存统计。Token 消耗图在总 token 柱内覆盖显示缓存 token，并单独显示缓存百分比和累计缓存 token。

### 当前工具

| 工具 | 用途 |
| --- | --- |
| `web_search` | 联网搜索与事实核验，由 MCP 搜索服务执行 |
| `text_to_image` | 生成无原图的新图片成品 |
| `image_edit` | 基于一张主图和最多三张参考图生成编辑结果 |
| `view_image` | 把历史会话图片加载给主模型，供识别、搜索决策或后续编辑 |

主模型本身支持多模态：当前轮上传图片直接进入模型上下文，不需要额外识图工具，单次最多四张。`image_edit` 把主图作为 API Image 1，最多三张参考图按 Image 2..4 发送；例如“图1放到图2右下角”会以图2为主图、图1为参考图。历史用户图或历史生成图作为主图或参考图时都必须先成功调用 `view_image`；未知附件 ID、跨用户或跨会话图片会被拒绝。OpenAI 兼容 `/images/edits` 多图使用 multipart `image[]`，MiniMax 图生图分支维持单图，传入参考图会明确报不支持而不会静默丢弃。

`ToolRegistry` 持有工具 schema 与 executor，可以在不改 AgentLoop 控制流的情况下注册或替换工具。图片工具有费用且只在用户明确要求实际图片成品时调用。

## 目录结构

```text
chat-lite/
├─ src/
│  ├─ server/
│  │  ├─ core/                         # db / http / security / mail
│  │  ├─ modules/
│  │  │  ├─ auth/                      # 登录、注册、邀请码、邮箱验证
│  │  │  ├─ chat/
│  │  │  │  ├─ engine/
│  │  │  │  │  ├─ agent-loop.ts       # 两阶段 ReAct 主循环
│  │  │  │  │  ├─ model-retry.ts      # 模型错误分类与重试
│  │  │  │  │  ├─ prompt-cache.ts      # 显式前缀缓存与兼容降级
│  │  │  │  │  ├─ tool-def.ts         # Agent / Tool 类型与上下文
│  │  │  │  │  └─ tool-registry.ts    # 工具注册、schema 与执行器
│  │  │  │  ├─ tools/                  # 搜索、文生图、图片编辑
│  │  │  │  ├─ chat.ts                 # 聊天 HTTP/SSE 边界
│  │  │  │  └─ chat.service.ts
│  │  │  ├─ images/                    # 图片服务
│  │  │  ├─ uploads/                   # 附件上传与鉴权文件访问
│  │  │  ├─ rag/                       # rag.db / sqlite-vec / FTS5 / chunker
│  │  │  ├─ usage/                     # token_usage / image_usage
│  │  │  └─ events/                    # 多设备 SSE
│  │  └─ index.ts
│  └─ web/
│     ├─ features/chat/                 # ChatPage / MessageList / 输入与消息操作
│     ├─ features/messages/
│     │  ├─ MarkdownMessage.tsx         # think 块和消息入口
│     │  ├─ StreamingMarkdown.tsx       # Markdown/code 分块
│     │  ├─ StreamingCodeBlock.tsx      # rAF 合并与流式 tokenizer
│     │  ├─ streamingMarkdownParser.ts  # 纯 fenced-block parser
│     │  ├─ shikiHighlighter.ts         # lazy highlighter / grammar manager
│     │  └─ codeBlockHelpers.ts         # 无 Shiki runtime 的轻量 helper
│     ├─ features/auth/
│     └─ App.tsx
├─ scripts/                             # smoke、RAG 与运维脚本
├─ test/                                # 独立 sanity 脚本
├─ deploy/                              # 容器重建脚本
├─ data/                                # app.db / rag.db / uploads
├─ Dockerfile
├─ docker-compose.yml
├─ .nvmrc
└─ .env.example
```

## 核心功能

### 1. 手写 AgentLoop

单个主模型负责工具决策和最终回答。循环显式维护工具调用结果、预算、重复调用保护、图片停止条件、模型重试、AbortSignal 与 SSE `think` / `delta` / `usage` 事件，不依赖额外意图分类模型。

### 2. 可插拔 ToolRegistry

工具名称、Zod schema、OpenAI function schema 和 executor 集中注册。AgentLoop 只面向统一 ToolDef 接口，搜索、图片生成、图片编辑和历史图片查看可以独立演进。

### 3. 两阶段流式回答

工具决策 rounds 不向用户输出正式正文。决策结束后进入禁用工具的 final round，并把最终内容以 SSE delta 流式发送；前端按每个会话、每个 animation frame 合并 delta，终止或取消前同步 flush。

### 4. 会话和消息操作

- 支持多会话并发生成，每个会话独立维护任务、取消信号、活动状态和 delta buffer。
- 支持消息编辑、重新生成、删除消息对和删除会话。
- assistant 状态区分 `streaming`、`completed`、`interrupted` 和 `error`。
- `/api/events` 向同账号的其他设备推送 `messages_changed`、`conversations_changed` 和 `conversation_deleted`。

### 5. RAG 长期记忆

- RAG 数据存放在独立 `rag.db`，检索隔离边界是当前 `conversation_id`，不会跨会话召回。
- 写入异步执行，不阻塞聊天；语义切块失败时回退到简单切块。
- 混合召回同时使用 sqlite-vec cosine 向量候选和 FTS5 trigram 关键词候选。
- 两路结果使用 RRF 融合（向量权重 0.7、关键词权重 0.3），再应用距离阈值和 Top-K。
- 每个会话按规范化内容 hash 做精确去重；召回阶段结合向量相似度与文本 Jaccard 做近似去重。
- sqlite-vec 或嵌入服务不可用时保留可用索引并降级；FTS5 不可用时继续使用向量路径。

### 6. Markdown 与代码块

- Markdown 继续使用 markdown-it 渲染并由 DOMPurify 清洗，跨代码块的 reference definitions 仍可解析。
- `<think>...</think>` 作为可折叠思考区，正文逐字符保留原始空白。
- 未闭合 fence 在流式期间增量高亮；消息结束后启用 raw code 复制和下载。
- 普通行内代码不进入 fenced code parser；列表和 blockquote 中的 fence 保持原 Markdown 语义。

## 本地运行

要求 **Node.js 24.18.0**。仓库根目录的 `.nvmrc` 固定为 `24.18.0`；使用支持 `.nvmrc` 的版本管理器时先选择该版本，并用 `node -v` 确认输出为 `v24.18.0`。

```powershell
cd D:\chat-lite
node -v
Copy-Item .env.example .env
# 编辑 .env，至少填写模型 API、邀请码，以及实际启用能力对应的 key
npm install
npm run dev:server
```

另开一个终端启动前端：

```powershell
cd D:\chat-lite
npm run dev
```

浏览器打开 `http://localhost:5173`。后端默认监听 `3000` 端口。

## 配置（.env）

以 `.env.example` 为准。未启用的外部能力可以不填对应 key；不要把真实密钥提交到仓库。
`VITE_STREAM_MARKDOWN_INTERVAL_MS` 是 Vite 构建时变量，修改后需要重新构建前端。

### 基础与 Agent

```env
NODE_ENV=production
PORT=3000
APP_ORIGIN=https://your-domain.example
DATA_DIR=./data
UPLOAD_DIR=./data/uploads
DATABASE_PATH=./data/app.db
SESSION_COOKIE_NAME=chat_lite_session
SESSION_TTL_DAYS=30
INVITE_CODE=your-private-invite-code
MAX_UPLOAD_MB=5
VITE_STREAM_MARKDOWN_INTERVAL_MS=50

AGENT_RECURSION_LIMIT=25
AGENT_MAX_TOOL_CALLS=25
AGENT_MAX_IMAGE_GENERATION_CALLS=10
AGENT_MAX_IMAGE_TO_IMAGE_CALLS=1
ANSWER_HISTORY_LIMIT=6
```

### 主模型与标题生成

```env
MODEL_API_KEY=...
MODEL_BASE_URL=https://your-openai-compatible-endpoint/v1
MODEL_NAME=your-model
MODEL_TEMPERATURE=0.1
MODEL_MAX_ATTEMPTS=2

# 可选；为空时标题生成回退到 MODEL_*
TITLE_API_KEY=...
TITLE_BASE_URL=https://your-title-endpoint/v1
TITLE_MODEL_NAME=your-title-model
TITLE_MODEL_TEMPERATURE=0
```

`OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 仍作为向后兼容别名；新配置优先使用 `MODEL_*`。

### 图片服务

```env
TEXT_IMAGE_API_URL=https://your-endpoint/v1/images/generations
TEXT_IMAGE_API_KEY=...
TEXT_IMAGE_MODEL=gpt-image-2
TEXT_IMAGE_MAX_BATCH=10
TEXT_IMAGE_DEFAULT_BATCH=1
TEXT_IMAGE_MAX_PARALLEL=4
TEXT_IMAGE_RESPONSE_FORMAT=b64_json
TEXT_IMAGE_SIZE=auto
TEXT_IMAGE_QUALITY=low

IMAGE_EDIT_API_URL=https://your-endpoint/v1/images/edits
IMAGE_EDIT_API_KEY=...
IMAGE_EDIT_MODEL=gpt-image-2
IMAGE_EDIT_SOURCE_MODE=multipart
IMAGE_EDIT_REFERENCE_TYPE=character
IMAGE_EDIT_RESPONSE_FORMAT=b64_json
IMAGE_EDIT_SIZE=auto
IMAGE_EDIT_QUALITY=low
```

### 搜索 MCP

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
RAG_SHADOW_ENABLED=true
RAG_TOP_K=3
RAG_MAX_DISTANCE=0.4
RAG_CONTENT_MAX_CHARS=600
RAG_CHUNK_ENABLED=true
RAG_CHUNK_MAX_CHARS=600
RAG_DATABASE_PATH=./data/rag.db

EMBEDDING_API_KEY=...
EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
EMBEDDING_DIMENSIONS=1024

RAG_CHUNK_MODEL_API_KEY=...
RAG_CHUNK_MODEL_BASE_URL=https://your-endpoint/v1
RAG_CHUNK_MODEL_NAME=your-model
RAG_CHUNK_MODEL_TEMPERATURE=0

RAG_BACKFILL_BATCH_SIZE=20
RAG_BACKFILL_DELAY_MS=1000
```

### 邮件

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="Chat Lite <...>"
```

## 验证

```powershell
node -v
npm run typecheck
npm run build
npm run smoke
```

## Docker 部署

当前仓库提供 `Dockerfile` 和 `docker-compose.yml`。Compose 将宿主机 `./data` 挂载到容器 `/data`，并暴露 `3000` 端口。

```bash
cp .env.example .env
# 编辑 .env
docker compose up -d --build
docker compose ps
```

重建脚本支持通过 `COMPOSE_FILE` 指向当前 Compose 文件，并会执行 `/api/health` 检查：

```bash
COMPOSE_FILE=docker-compose.yml bash deploy/rebuild-chat-lite.sh
```

Docker镜像内置固定版本的 `uv` / `uvx` 和Python运行时；重建后无需额外下载或执行运行时安装脚本。`uvx` 首次下载MiniMax MCP及依赖时使用镜像内置的阿里云 PyPI 源 `https://mirrors.aliyun.com/pypi/simple`。

## 运维

```bash
# 历史消息写入 RAG 索引
docker compose exec chat-lite npm run rag:backfill

# 清理低频 RAG chunk（脚本默认 dry-run）
bash scripts/prune-rag.sh

# 查看每用户 token / 图片统计
bash scripts/usage-report.sh

# 需要完整重建 rag.db 时先停服务并删除独立数据库
docker compose stop chat-lite
rm -f data/rag.db data/rag.db-wal data/rag.db-shm
docker compose up -d chat-lite
```

## 数据隔离与安全

- 每条业务数据带 `user_id`；RAG 检索和去重按 `conversation_id` 隔离。
- 删除会话时消息、附件和对应 RAG chunk 一并清理。
- 前端不接受客户端传入的 `user_id`，身份来自 HttpOnly session cookie。
- session token 原文只保存在浏览器，数据库仅保存 hash。
- 上传文件限制 MIME 与大小，文件名随机化，并按用户目录保存。
- Markdown 禁用原始 HTML 并经过 DOMPurify 清洗。
- API key 只保存在服务端 `.env`。
- AbortSignal 从聊天请求传到模型、工具与上游 fetch，停止生成会断开对应任务。

## 限制

- 面向少量用户的单机私有部署，不支持水平扩展。
- 内存中的 SSE 连接和并发任务状态不跨进程共享。
- RAG 按当前会话隔离，不跨会话共享记忆。
- 图片生成耗时受上游服务影响。
- MCP stdio 工具依赖容器或宿主机提供对应运行时。

## License

Private / Proprietary.
