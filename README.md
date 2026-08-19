# Chat Lite

Chat Lite 是面向少量用户私用的单机 Chat Web。它不是面向水平扩展的 SaaS，也不依赖独立的消息队列或工作流编排服务。

当前运行边界：

- 运行时固定为 Node.js `24.18.0`。
- 前端是 React 19 + Vite + TypeScript。
- 后端使用原生 `node:http`，不是 Express 或其他 HTTP 框架。
- 业务数据使用 SQLite `app.db`；RAG 使用独立的 SQLite `rag.db`。
- 上传文件保存在本地 `uploads` 目录，实际默认路径为 `data/uploads`。
- 聊天正文和账号内事件使用 SSE；模型、搜索、嵌入和图片能力由外部服务提供。

## 架构

```text
Browser
  |
  +-- React 19 + Vite + TypeScript
  |     +-- 会话列表、消息、编辑器、图片上传
  |     +-- Markdown / DOMPurify / Shiki streaming
  |     +-- 搜索、usage dialog、GSAP 动画
  |
  +-- HTTP / SSE
          |
          v
Node.js 24.18.0 + native node:http
  +-- Auth: 注册、登录、邮箱验证码、邀请码
  +-- Session: HttpOnly cookie + SQLite token hash
  +-- Chat API: 聊天 SSE、取消、编辑、删除、重新生成
  |     +-- 会话上下文、摘要、有效历史、RAG 注入
  |     +-- 手写单智能体 ReAct AgentLoop
  |           +-- ChatOpenAI.bindTools
  |           +-- ToolRegistry
  |           +-- decision rounds
  |           +-- ToolMessage / view_image 轨迹
  |           +-- final response: tool_choice=none
  +-- Conversation concurrency: 多会话任务、delta buffer、activity
  +-- Message operations: 问答 pair 编辑、删除、附件清理
  +-- Events: 账号范围内的多设备 SSE 事件
  +-- Search: 当前用户的全局消息搜索
  +-- Usage: token、缓存 token、图片 usage、每日统计
  +-- RAG: 独立 rag.db、sqlite-vec、FTS5 trigram、RRF
  +-- Images: generations / edits / MiniMax MCP 适配
  |
  +-- app.db       账号、会话、消息、附件、usage
  +-- rag.db       RAG chunks、向量索引、RAG FTS
  +-- uploads/     本地上传和生成图片
```

AgentLoop 是单个主模型驱动的手写 ReAct 循环；工具决策、工具执行和最终回答都在同一个 AgentLoop 中完成。

### 技术栈

| 层 | 实现 |
| --- | --- |
| Runtime | Node.js `24.18.0`，`engines` 为 `>=24.18.0 <25` |
| Frontend | React `19.2.8`、ReactDOM、Vite、TypeScript、GSAP |
| Backend | 原生 `node:http`、TypeScript、esbuild |
| Database | `better-sqlite3`；业务库 `app.db`、RAG 库 `rag.db` |
| Auth | `argon2id`、HttpOnly session cookie、数据库 token hash |
| Markdown | `markdown-it` + `DOMPurify` |
| Code blocks | Shiki + `@shikijs/stream` + Oniguruma WASM |
| RAG | `sqlite-vec` + SQLite FTS5 trigram |
| Model | `ChatOpenAI` 的 OpenAI-compatible Chat Completions 接口 |
| Search MCP | MCP stdio client；默认通过 `uvx` 接入 MiniMax MCP |
| Image API | OpenAI-compatible `/images/generations`、`/images/edits`，以及 MiniMax 分支 |

## AgentLoop

### 执行阶段

一次 `/api/chat` 请求的主要流程如下：

1. 创建固定顺序的工具 schema 和 `ToolRegistry`。
2. 用 `ChatOpenAI.bindTools(tools)` 创建工具决策模型。
3. 模型执行一个或多个 decision rounds。每轮只输出结构化 tool calls，或输出服务器识别的结束 marker；不会把决策阶段的正文当作用户最终回答。
4. 每个 tool call 真实执行后，结果作为 `ToolMessage` 追加回消息数组，再进入下一 decision round。彼此独立的调用可以在同一轮并发执行，但最终按模型调用顺序组装结果。
5. 决策结束后追加服务器的 final runtime control，再用同一组工具绑定 `tool_choice: 'none'` 的模型流式生成最终回答。

模型阶段由 `model-retry.ts` 分类错误并按 `MODEL_MAX_ATTEMPTS` 重试，实际值限制在 1 到 3 次。可重试的连接、超时、部分限时速率错误和服务端错误才会重试；取消、认证/额度错误、普通参数错误不重试。最终回答已经向用户提交部分正文后发生的流中断也不重新发起一条回答。`AbortSignal` 会传递到模型、工具和上游 fetch，取消会停止当前请求和等待中的重试延迟。

工具调用总数、图片调用数、递归步数和相同参数重复调用都有限制。预算拒绝或工具失败的结果仍会回到模型，模型不能把未执行的动作当成成功。

### 当前工具

| Tool | 行为 |
| --- | --- |
| `web_search` | 通过 MCP 搜索服务联网搜索；用于实时信息、事实核验、证据不足和专业问题 |
| `text_to_image` | 不依赖原图生成新的图片成品；会保存为附件并记录 image usage |
| `image_edit` | 以一张主图和最多三张参考图生成编辑结果；会保存新附件 |
| `view_image` | 从当前会话的历史图片候选中读取图片本体，供后续识别、搜索或编辑 |

图片规则：

- 当前轮上传的图片会直接以内联 `data:` 图片内容放进当前 user message，最多接收 4 张；当前轮图片不需要先调用 `view_image`。
- 历史用户图片和历史生成图片只先作为候选摘要提供给模型。要依据它们的内容进行识别、搜索或编辑，必须先用准确的候选 `attachmentId` 调用 `view_image`；成功后图片本体会在下一 decision round 追加到模型上下文。未知 ID、跨用户或跨会话附件会被拒绝。
- `image_edit.attachmentId` 是主画布，`referenceAttachmentIds` 最多 3 个。后端按 Image 1、Image 2..4 发送；例如“把图 1 放到图 2 右下角”时，图 2 应是主图，图 1 是参考图。
- 普通 OpenAI-compatible `/images/edits` 路径使用 multipart；这不是 `IMAGE_EDIT_SOURCE_MODE` 的含义。MiniMax 图生图分支不支持参考图，只接受一张主图。
- MiniMax 主图来源支持 `base64` 或 signed URL。`IMAGE_EDIT_SOURCE_MODE=signed-url` 时优先发送 signed URL，其他值优先发送 base64；首选方式失败后会尝试另一种方式。signed URL 由服务端生成，仍受会话和用户权限检查。
- 图片生成和编辑是可能产生供应商费用的外部副作用，只有用户明确要求实际图片成品且要求足够明确时才调用。

## Prompt cache 与会话上下文

### 实际消息顺序

工具 schema 和固定 System/Instruction 是缓存公共前缀的一部分。`SYSTEM_PROMPT_BASE` 与 `AGENT_LOOP_INSTRUCTION` 当前合并为固定 `SystemMessage`；工具由 `ToolRegistry` 以稳定顺序转换为 OpenAI function schema。每次请求的逻辑上下文顺序是：

```text
固定 tools + 固定 System/Instruction
  -> conversation summary
  -> effective history
  -> current user（文字和本轮图片）
  -> retrieved RAG context
  -> 初始图片候选说明
  -> append-only 的 assistant/tool/view_image 轨迹
```

RAG 明确位于当前 user 之后，不在历史之前。图片候选说明只在本轮初始化时追加一次；之后模型产生的 assistant tool-call、`ToolMessage`、工具结果和成功 `view_image` 的多模态观察按追加方式进入消息数组。`view_image` 在协议中表现为追加的图片 user block，但它是对工具结果的观察轨迹，不是新的用户问题。

### 摘要和历史

- `conversation_context_states` 在 `app.db` 中按会话保存摘要、摘要 token 估计、摘要覆盖游标、最近用户消息时间以及更新时间。
- 摘要只在存在被丢弃的旧消息且满足触发条件时更新：一是成本判断，二是两次用户请求间空闲时间超过 `CONVERSATION_CACHE_IDLE_MINUTES`，默认 15 分钟。两者可同时触发。
- 成本判断使用 `MODEL_INPUT_PRICE_PER_MILLION`、`MODEL_CACHED_INPUT_PRICE_PER_MILLION` 和 `CONVERSATION_CONTEXT_COST_RATIO` 对上下文保留策略作比较。这些变量是上下文决策系数，不是货币计费或供应商账单的结算变量。
- `ANSWER_HISTORY_LIMIT=6` 的尾部保留语义是 5 条有效历史消息加当前 user，而不是 6 条旧历史。没有满足压缩条件时，游标之后的有效历史会暂时全部保留；满足条件后才按尾部 5 条收缩。
- 有效历史会过滤掉不可见的 streaming、error、纯 think、已取消和失败占位 assistant 内容；可见 assistant 会去掉 `<think>` 块。
- 游标是复合游标：`summarized_through_created_at` + `summarized_through_message_id`。查询条件是时间更晚，或时间相同但 message ID 更大，避免同一时间戳消息在分页/并发时被跳过。
- 摘要调用 `createTitleModel()`，沿用 `TITLE_*` 配置并在本轮上下文准备阶段等待结果；首轮会话标题生成则在回答完成后另行异步调度。标题和摘要使用同一套 title model 创建入口，但不是同一条数据库消息。
- 摘要不是聊天 message，也不会写入 RAG；RAG 只异步索引可见的 user/assistant 原始消息。

已知降级风险：摘要模型失败时错误会被吞掉，旧摘要可能保持不变，而压缩游标仍会前移，旧消息因此可能不再进入模型上下文。RAG 检索失败会返回空检索上下文；缓存转换失败会 fail-open 使用原始请求。需要依赖长期事实时，应保留可核验的当前消息或重新说明关键信息。

### 显式缓存断点和统计

缓存转换发生在发往 `/chat/completions` 的 provider 请求体上：

1. 第一个 `prompt_cache_breakpoint` 是 provider metadata，标在固定 System/Developer 消息的稳定 text block 上。
2. 第二个断点从消息数组尾部向前寻找最后一个可缓存 content block。它可能落在当前 user、tool result、`view_image` 图片或最终 runtime control 等块上，不能保证固定在当前 user 末尾。
3. `prompt_cache_key` 只由 model、固定 System 文本和有序 tools schema 组成，不包含 RAG、历史、当前 user 或随机请求 ID。
4. 断点声明只是请求元数据，不等于 provider 已命中缓存；只有 provider 返回的实际 cached prompt token 才是命中证据。
5. 如果 provider 明确拒绝显式缓存字段，当前 Agent run 会用未转换的原始请求回退一次，并停止后续显式转换。普通 400、取消、限流或已经开始的流不会因为缓存字段而盲目重试。

`token_usage` 的缓存率只使用有实际测量的 prompt 输入作为分母：`cached_tokens / cache_measured_prompt_tokens`。旧记录的两个缓存字段保持 `NULL`，因此历史没有测量时显示未知，而不是显示 0%；真实测到的缓存 miss 才是分子 0。usage dialog 的每日缓存率使用当天同样的 measured prompt denominator。

## RAG

RAG 是按 `conversation_id` 隔离的会话记忆。`user_id` 用于归属和权限日志，但检索边界是会话本身，不能跨会话召回相同用户的内容。

### 写入和检索

- 写入在聊天响应之外 fire-and-forget，不阻塞 SSE；只索引可见的 user/assistant 消息。消息删除、编辑或不可见时会清理对应 chunks。
- 内容先清理 think 块、图片 Markdown、代码块和 HTML，再按 `RAG_CONTENT_MAX_CHARS` 截断。启用语义切块且配置了 chunk model 时使用语义切块；请求失败、JSON 无效、模型未配置或文本太短时回退到简单切块。
- 每个 chunk 用规范化文本的 SHA-256 `content_hash` 做 exact content hash 去重，唯一边界为 `(conversation_id, content_hash)`。同一会话重复内容会按时间、importance 和 role 选择代表；不同会话的相同内容仍分别保存。
- 向量路径使用 `sqlite-vec` cosine distance，关键词路径使用 FTS5 `trigram`。两路各取候选后用 RRF 融合：向量权重 `0.7`，关键词权重 `0.3`；应用 `RAG_MAX_DISTANCE` 和 `RAG_TOP_K`，默认 `TopK=3`。
- 召回阶段还会做近重复合并：两个候选同时满足 cosine 相似度至少 `0.95` 和文本 Jaccard 至少 `0.85` 时归为一组，只保留代表。
- query embedding 失败时降级为关键词检索。`sqlite-vec` 不可用时继续保留文本/metadata 索引；FTS5 不可用时继续尝试向量路径。两种索引都不可用时不会伪造召回结果。
- embedding 在已有索引上部分失败时保留旧索引；新消息 embedding 不完整时仍可写入 keyword-only chunks。

摘要不会写入 `rag.db`。RAG 只接受实际 message 的原始内容，因此不会把模型压缩摘要当成检索事实源。

### 删除语义

`app.db` 中的会话/消息删除先在自己的 SQLite 事务中提交。因为 `rag.db` 是独立数据库，RAG chunks、对应的 `vec_rag_items` 和 FTS 行会在业务事务提交后再清理；清理失败只记录 warning，不回滚已经提交的业务删除。因此删除通常会跟随清理，但不能把它描述为跨数据库的原子绝对保证。服务启动时还会清理部分 orphaned 或不可见 chunks。

## 前端行为

### 消息渲染

- Markdown 使用 `markdown-it` 渲染，再由 `DOMPurify` 清洗；原始 HTML 不作为 Markdown 功能开放。
- 数学内容没有专用数学渲染器，数学公式按普通文本、Unicode 字符或 Markdown 代码块显示。
- 顶层 fenced code block 在 streaming 时由轻量 parser 分离；列表、引用和其他嵌套 fence 继续交给 `markdown-it`。
- Shiki、Oniguruma WASM、stream tokenizer 和语言 grammar lazy load。streaming tokenizer 使用 recall 合并稳定/不稳定 token，React 更新通过 `requestAnimationFrame` 批处理。
- 代码内容按 UTF-8 bytes 判断；小于或等于 `100KB` 才尝试 Shiki，超过后回退纯文本。运行时能力、WASM、语言加载或 tokenization 失败也回退，不阻断消息显示。
- 完成后的代码块支持复制和下载；流式期间动作会禁用。普通消息也提供复制，用户消息提供编辑和删除入口。

### 会话、搜索和 usage

- UI 采用 mobile-first 布局、浅色纯色配色和 GSAP 动画；动画检查 `prefers-reduced-motion: reduce`，减少动画时不强制播放过渡效果。
- 侧栏会话菜单支持 pin/unpin、rename 和 delete。重命名会规范化空白并限制 1 到 40 个字符；手动标题会设置保护标记，后续自动标题不会覆盖。删除前显示确认；会话存在 streaming assistant 时服务端返回 HTTP `409`，必须先停止生成。
- 消息编辑和删除以用户消息为入口处理一组问答 pair。编辑最新 pair 时替换其 assistant；编辑历史 pair 时追加新的编辑问答。删除会同步处理对应 assistant 和关联图片，若删除后会话为空，会话本身也可能被删除。
- 多个会话可以同时生成。每个会话有独立的任务、取消信号、delta buffer 和 activity；侧栏显示生成中、完成未读或错误状态。`/api/events` 为同账号的其他设备推送会话和消息变化，SSE 连接每 25 秒 heartbeat。
- 全局消息搜索只查询当前登录用户的可见 user/assistant 消息。空输入直接清空结果，不发送请求；查询长度超过 200 个字符被拒绝。长度至少 3 个字符时使用 FTS5 trigram，较短查询使用转义后的 `LIKE`，结果按 offset 分页，每页 30 条。点击结果会打开对应会话、定位消息并高亮。
- profile 中的 usage dialog 显示总输入 token、总输出 token、总缓存 token，以及最近 7 天的输入/输出/缓存序列；缓存 token 是输入 token 的子集。每日 cache rate 的分母只包含 `cache_measured_prompt_tokens`，全为 NULL 的旧日期显示 `--`。图片 usage 另显示总量和最近 7 天图表。

## 目录结构

下面只列当前实现中存在的主要文件和目录：

```text
chat-lite/
├─ src/
│  ├─ server/
│  │  ├─ core/                         # db、HTTP、security、events
│  │  ├─ modules/
│  │  │  ├─ auth/                      # auth.ts、auth.service.ts、auth.repo.ts、mail.ts
│  │  │  ├─ chat/
│  │  │  │  ├─ engine/
│  │  │  │  │  ├─ agent-loop.ts
│  │  │  │  │  ├─ model-retry.ts
│  │  │  │  │  ├─ prompt-cache.ts
│  │  │  │  │  ├─ tool-def.ts
│  │  │  │  │  └─ tool-registry.ts
│  │  │  │  ├─ tools/                  # web-search、text-image、image-edit、view-image
│  │  │  │  ├─ conversation-context.config.ts
│  │  │  │  ├─ conversation-context.repo.ts
│  │  │  │  ├─ conversation-context.service.ts
│  │  │  │  ├─ conversation-summary.service.ts
│  │  │  │  ├─ history-limits.ts
│  │  │  │  ├─ message-visibility.ts
│  │  │  │  ├─ chat.ts、chat.service.ts、chat.repo.ts
│  │  │  │  └─ model.ts
│  │  │  ├─ conversation-titles/
│  │  │  ├─ images/                    # generations、edits、MiniMax 适配
│  │  │  ├─ uploads/                   # 本地上传、鉴权文件访问
│  │  │  ├─ rag/                       # rag.db、sqlite-vec、FTS、chunker、backfill
│  │  │  ├─ search/                    # 全局消息搜索路由和 repository
│  │  │  ├─ usage/                     # token_usage、image_usage、统计
│  │  │  └─ profile/
│  │  └─ index.ts
│  └─ web/
│     ├─ app/                          # App.tsx、main.tsx
│     ├─ features/
│     │  ├─ auth/                      # 登录、注册
│     │  ├─ chat/
│     │  │  ├─ ChatPage.tsx
│     │  │  ├─ ConversationList.tsx
│     │  │  ├─ ConversationActionsMenu.tsx
│     │  │  ├─ ConversationSearch.tsx
│     │  │  ├─ RenameConversationDialog.tsx
│     │  │  ├─ DeleteConversationDialog.tsx
│     │  │  ├─ DeleteMessageDialog.tsx
│     │  │  ├─ MessageList.tsx、MessageActions.tsx
│     │  │  ├─ InlineMessageEditor.tsx
│     │  │  ├─ MessageInput.tsx、ImageUploader.tsx
│     │  │  ├─ messageContent.ts
│     │  │  ├─ conversationDeltaBuffer.ts
│     │  │  └─ conversationActivity.ts
│     │  ├─ messages/
│     │  │  ├─ MarkdownMessage.tsx、StreamingMarkdown.tsx
│     │  │  ├─ StreamingCodeBlock.tsx
│     │  │  ├─ streamingMarkdownParser.ts
│     │  │  ├─ shikiHighlighter.ts、codeBlockHelpers.ts
│     │  │  └─ markdownReferences.ts、thinkBlocks.ts
│     │  └─ profile/
│     │     ├─ ProfileMenu.tsx
│     │     └─ UsageDialog.tsx
│     ├─ shared/api/client.ts
│     └─ styles.css
├─ scripts/                            # smoke、usage-report、RAG 运维
├─ test/                               # 独立 sanity 和 live probe 脚本
├─ deploy/rebuild-chat-lite.sh
├─ Dockerfile
├─ docker-compose.yml
├─ docker-compose.prod.yml              # 当前工作区可见；服务器副本不一定有
├─ .nvmrc
└─ .env.example
```

## 本地运行

要求 `node -v` 输出 `v24.18.0`。`.nvmrc` 也固定为 `24.18.0`。

```powershell
node -v
Copy-Item .env.example .env
# 编辑 .env，至少配置 MODEL_API_KEY、MODEL_BASE_URL、MODEL_NAME 和 INVITE_CODE
npm install
npm run dev:server
```

另开一个终端启动 Vite：

```powershell
npm run dev
```

默认端口：

- 后端：`http://localhost:3000`
- Vite：`http://localhost:5173`
- Vite 开发服务器把 `/api` 代理到 `http://localhost:3000`。

生产构建和启动：

```powershell
npm run build
npm run start
```

`npm run build` 会构建前端、服务端和 RAG backfill bundle；`npm run start` 启动 `dist-server/index.js`。生产环境应使用长期保存的 `.env` 和 `data`，不要把密钥写入源码或镜像层。

## 配置

配置分组以 `.env.example` 为准。示例文件中的 endpoint、model、邀请码和 SMTP 值都是部署示例，不代表源码内置默认值；真实密钥只放在服务端 `.env`。

### 基础和前端

```env
NODE_ENV=production
PORT=3000
APP_ORIGIN=https://your-domain.example
DATA_DIR=./data
UPLOAD_DIR=./data/uploads
DATABASE_PATH=./data/app.db
SESSION_COOKIE_NAME=chat_lite_session
SESSION_TTL_DAYS=30
INVITE_CODE=replace-me
MAX_UPLOAD_MB=5
VITE_STREAM_MARKDOWN_INTERVAL_MS=50
```

`VITE_STREAM_MARKDOWN_INTERVAL_MS` 是 Vite 构建时变量，改动后要重新构建前端。`DATA_DIR`、`DATABASE_PATH`、`RAG_DATABASE_PATH` 和 `UPLOAD_DIR` 在容器中通常改为 `/data` 下的路径。

### Agent、retry 和 history

```env
AGENT_RECURSION_LIMIT=25
AGENT_MAX_TOOL_CALLS=25
AGENT_MAX_IMAGE_GENERATION_CALLS=10
AGENT_MAX_IMAGE_TO_IMAGE_CALLS=1
ANSWER_HISTORY_LIMIT=6
MODEL_MAX_ATTEMPTS=2
```

它们分别限制决策递归、总工具调用、文生图、图生图、历史尾部语义和每个模型阶段的重试次数。工具预算实际还受图片停止条件和重复调用保护影响。

### MODEL / TITLE

```env
MODEL_API_KEY=...
MODEL_BASE_URL=https://your-openai-compatible-endpoint/v1
MODEL_NAME=your-model
MODEL_TEMPERATURE=0.1

TITLE_API_KEY=...
TITLE_BASE_URL=https://your-title-endpoint/v1
TITLE_MODEL_NAME=your-title-model
TITLE_MODEL_TEMPERATURE=0
```

`MODEL_*` 是主模型配置；标题和会话摘要从 `TITLE_*` 创建模型，空值时回退到 `MODEL_*`。当前 `title.service.ts` 实际固定标题模型 temperature 为 `0.2`，`.env.example` 中的 `TITLE_MODEL_TEMPERATURE` 只是示例字段，当前运行时不读取它。

兼容别名仍可用：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`。新部署优先使用 `MODEL_*`。如果没有配置模型名，源码 fallback 是 `gpt-4o-mini`；这不等于 `.env.example` 中示例的模型值。

### Text image

```env
TEXT_IMAGE_API_URL=https://your-endpoint/v1/images/generations
TEXT_IMAGE_API_KEY=...
TEXT_IMAGE_MODEL=your-image-model
TEXT_IMAGE_MAX_BATCH=10
TEXT_IMAGE_MAX_PARALLEL=4
TEXT_IMAGE_RESPONSE_FORMAT=b64_json
TEXT_IMAGE_SIZE=auto
TEXT_IMAGE_QUALITY=low
```

当前运行时控制批量的是 `TEXT_IMAGE_MAX_BATCH` 和 `TEXT_IMAGE_MAX_PARALLEL`。`.env.example` 中的 `TEXT_IMAGE_DEFAULT_BATCH` 目前没有被源码读取，修改它不会改变运行时行为，不应把它当成有效配置。

### Image edit

```env
IMAGE_EDIT_API_URL=https://your-endpoint/v1/images/edits
IMAGE_EDIT_API_KEY=...
IMAGE_EDIT_MODEL=your-edit-model
IMAGE_EDIT_SOURCE_MODE=base64
IMAGE_EDIT_REFERENCE_TYPE=character
IMAGE_EDIT_RESPONSE_FORMAT=b64_json
IMAGE_EDIT_SIZE=auto
IMAGE_EDIT_QUALITY=low
```

普通 OpenAI-compatible edit endpoint 使用 multipart，单图字段为 `image`，多图字段为 `image[]`。`IMAGE_EDIT_SOURCE_MODE` 只决定 MiniMax 分支优先把主图作为 base64 还是 signed URL：只有精确值 `signed-url` 才优先 signed URL，其他值优先 base64，失败后交替回退。不要把 `IMAGE_EDIT_SOURCE_MODE=multipart` 理解成唯一或通用的上传模式。MiniMax 分支不接受参考图。

### MiniMax MCP

```env
MINIMAX_API_KEY=...
MINIMAX_API_HOST=https://api.minimaxi.com
MINIMAX_MCP_COMMAND=uvx
MINIMAX_MCP_ARGS=minimax-coding-plan-mcp -y
MINIMAX_MCP_BASE_PATH=./data
```

`web_search` 通过 MCP stdio client 使用这些设置。Docker 镜像内置 `uv` 和 `uvx`，宿主机直接运行时需要自行提供 `uvx` 及 MCP 依赖。

### RAG、embedding 和 chunker

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
EMBEDDING_BASE_URL=https://your-embedding-endpoint/v1
EMBEDDING_MODEL=your-embedding-model
EMBEDDING_DIMENSIONS=1024

RAG_CHUNK_MODEL_API_KEY=...
RAG_CHUNK_MODEL_BASE_URL=https://your-chunker-endpoint/v1
RAG_CHUNK_MODEL_NAME=your-chunker-model
RAG_CHUNK_MODEL_TEMPERATURE=0

RAG_BACKFILL_BATCH_SIZE=20
RAG_BACKFILL_DELAY_MS=1000
```

`.env.example` 中的 `Qwen/Qwen3-Embedding-0.6B` 和 `1024` 维是示例配置，不是项目强制默认。源码在没有 embedding 配置时 fallback 到 `text-embedding-3-small` 和 `1536` 维；实际模型返回维度必须和 `EMBEDDING_DIMENSIONS` 一致。修改维度后应按 RAG 运维流程重建/回填向量索引。

### SMTP

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="Chat Lite <...>"
```

SMTP 用于注册和邮箱验证码；生产环境应使用邮件服务的应用密码或专用凭据。

### Context pricing / summary

```env
MODEL_INPUT_PRICE_PER_MILLION=5
MODEL_OUTPUT_PRICE_PER_MILLION=30
MODEL_CACHED_INPUT_PRICE_PER_MILLION=0.5
CONVERSATION_SUMMARY_MAX_TOKENS=2048
CONVERSATION_CACHE_IDLE_MINUTES=15
CONVERSATION_CONTEXT_COST_RATIO=1.2
```

这一组变量用于会话上下文成本策略，不是货币单价、供应商计费配置，也不会替代 provider 返回的真实账单。当前压缩比较实际使用输入和缓存输入的配置；`MODEL_OUTPUT_PRICE_PER_MILLION` 保留在同一策略配置组中，但不应解释为 usage dialog 的货币计费。

## 验证和测试脚本

常规命令如下。本文更新时没有运行这些命令：

```powershell
npm run typecheck
npm run build
npm run smoke
```

`npm run smoke` 会启动已经构建好的 `dist-server/index.js`，使用临时 data 目录检查 health、未登录认证和邀请码错误路径，因此通常在 `npm run build` 后运行。

`test/` 是独立的 Node sanity 脚本，当前覆盖的类别包括：

- Agent prompt contract、model retry、prompt cache transform、cache usage 和 legacy usage migration。
- conversation delta buffer、conversation activity、message visibility、message pair 编辑/删除。
- streaming Markdown、think blocks、Shiki stream、代码块 fallback。
- 全局搜索 backend/UI 的可见性、FTS/LIKE、分页和跳转行为。
- RAG hybrid 的 sqlite-vec/FTS、conversation isolation、exact hash 和近重复处理。
- 多图编辑的 schema、候选解析、multipart runtime 和工具边界。

对应文件名以 `*-sanity.mjs` 结尾，例如 `test/prompt-contract-sanity.mjs`、`test/rag-hybrid-sanity.mjs`、`test/search-backend-sanity.mjs`、`test/streaming-markdown-sanity.mjs` 和 `test/multi-image-edit-runtime-sanity.mjs`。这些脚本没有统一的 `npm test` 入口，需要按文件用 `node test/<file>.mjs` 执行。

live probe 默认关闭或需要显式环境变量，例如 `RUN_LIVE_PROMPT_CACHE=1`、`RUN_LIVE_REACT_CACHE=1`、`RUN_LIVE_REACT_CACHE_IMPLICIT=1`、`RUN_LIVE_TEXT_IMAGE=1`。`test/test-prompt-cache.mjs` 和 `test/test-embedding.mjs` 在直接调用且配置完整时会访问外部服务。live probe 会产生供应商请求；图片 probe 可能产生实际图片费用，prompt cache、embedding 和模型 probe 也可能产生 token 费用。不要把它们当作离线 sanity 测试。

## Docker

### 镜像和 Compose

- `Dockerfile` 的构建阶段使用 `node:24.18.0-bookworm-slim`，runner 也固定 Node 24.18.0。
- deps、build、prod-deps 阶段刻意串成低内存路径；`JOBS=1`、`MAKEFLAGS=-j1`、`GOMAXPROCS=1`、npm 并发限制和 Node heap 限制用于 2 核/2GB 一类服务器。代价是构建更慢。
- 镜像内置 Python、`uv` 和 `uvx`，供 MiniMax MCP 使用；不依赖容器启动时临时安装 uv。
- `docker-compose.yml` 把宿主机 `./data` 挂载到容器 `/data`，服务端暴露 `3000`。
- `docker-compose.prod.yml` 还定义 nginx 和 certbot，并把服务器的 data、nginx 配置、certbot webroot/证书目录挂载进容器。当前工作区可见该文件，但部署服务器上的副本可能缺失或使用未被 Git 跟踪的生产文件。

基础 Compose 启动：

```bash
cp .env.example .env
# 编辑 .env
docker compose -f docker-compose.yml up -d --build
docker compose -f docker-compose.yml ps
```

### 重建脚本

`deploy/rebuild-chat-lite.sh` 的选择顺序是显式 `COMPOSE_FILE`，其次是存在的 `docker-compose.prod.yml`，最后是 `docker-compose.yml`。默认 `STOP_BEFORE_BUILD=1`，会先停止旧的 chat service，释放内存，再 build、force-recreate，并通过最多 30 次、每次 2 秒的 `/api/health` polling 判断服务是否就绪。失败时打印最近日志。

```bash
COMPOSE_FILE=docker-compose.prod.yml bash deploy/rebuild-chat-lite.sh
```

部署时不要用 `git clean`、强制覆盖、`docker compose down -v` 或批量复制替换服务器上的 `.env`、`data`、nginx 配置、certbot webroot/证书和其他未跟踪生产状态。服务器可以有仓库没有的生产 Compose 或部署文件；更新应用镜像时只替换代码/镜像所需部分，先备份并核对 data mount 和配置路径。

## 运维

### RAG backfill

构建完成后可把历史可见消息写入 RAG：

```bash
npm run rag:backfill
npm run rag:backfill -- --limit 100 --delay 1500
npm run rag:backfill -- --user <user-id>
```

backfill 要求 `RAG_WRITE_ENABLED=true`。它会跳过已经完成的索引，清理不可见消息的 chunks，并按 batch/delay 调用 embedding 和 chunker；失败项记录在 summary 中。

### Usage report

```bash
bash scripts/usage-report.sh
APP_DB=/path/to/data/app.db bash scripts/usage-report.sh
```

脚本需要宿主机有 `sqlite3` 命令，输出按用户汇总 token、cached token、实际 measured denominator 的 cache rate，以及 image usage。`token_usage` 和 `image_usage` 是 append-only usage 记录；删除消息或会话不会让累计 usage 递减，也不会回收已经产生的供应商费用。

### RAG prune

prune 只处理独立 `rag.db` 中低 usefulness 的 chunks，不删除 `app.db` 的消息：

```bash
# 默认只预览候选
bash scripts/prune-rag.sh

# 确认后删除
bash scripts/prune-rag.sh --apply
bash scripts/prune-rag.sh --percent 30 --min-items 500 --apply
```

候选分数使用 hit count、最近命中/注入、importance 和创建时间。`--apply` 会在 `rag.db` 内的事务中同步删除 `rag_items`、向量行和 FTS 行；先做 dry-run，并在 apply 前备份 `rag.db`。它不是会话删除，也不会改变消息、摘要或 usage。

### 备份、恢复、端口和日志

- 备份应覆盖整个 `data/`：`app.db`、`rag.db`、SQLite WAL/SHM 文件和 `uploads/`。优先先停止服务或执行一致性 checkpoint，再复制；不要只在服务运行时随意复制单个 SQLite 主文件。
- 恢复时停止应用，恢复匹配的一组数据库和 uploads，再启动并检查 `/api/health`、会话、附件和 RAG 状态。RAG 可以单独重建，但重建前仍应保留原 `rag.db` 备份。
- 本地开发端口是 `3000` 和 `5173`；生产反向代理通常使用 `80/443`，应用容器仍监听 `3000`。
- Node 直接运行时查看进程标准输出；Compose 使用 `docker compose logs -f chat-lite`，部署失败先看 health polling 后打印的最近 100 行日志。

## 安全、隔离和限制

- 所有业务查询以已认证的 session 推导 `user_id`；客户端不能指定任意 `user_id`。session 原文只在浏览器 cookie 中使用，数据库保存 hash。
- 会话、消息和附件按用户及会话归属检查，生成图片按用户归属保存；RAG 检索的唯一内容边界是当前 `conversation_id`。
- 上传限制 MIME、大小和本地路径；文件名使用随机 attachment ID。`MAX_UPLOAD_MB` 的示例值为 5MB，实际以 `.env` 为准。
- API key 只在服务端使用。Markdown 禁止原始 HTML 并经过 DOMPurify；历史图片通过服务端权限检查后才可被 `view_image` 或图片编辑读取。
- 图片编辑最多一张主图和三张参考图；当前请求最多接收四张上传图片。Agent 的递归、工具、图片和并发任务仍受配置及工具保护限制。
- SSE 连接、正在运行的任务、取消状态和事件订阅保存在单个 Node 进程内，不跨进程共享；不支持水平扩展或多副本无状态部署。
- 外部模型、MCP、embedding、图片 API 的可用性、延迟、上下文限制和费用不由本项目保证。取消请求可能已经到达供应商，不能保证撤销供应商侧已产生的费用。

Private / Proprietary.
