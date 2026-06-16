# Chat Lite

轻量手机端 Chat Web 应用：React/Vite 前端 + Node.js 原生 HTTP TypeScript 后端 + SQLite + LangChain 单模型智能体 + MCP 工具适配。

## 当前架构

```text
Browser React TS
  ↓
Node.js 原生 HTTP API + 小型 TypeScript Router
  ├─ Auth: 邮箱密码 + 邮箱验证码 + 邀请码
  ├─ Session: HttpOnly Cookie + SQLite token hash
  ├─ Data: SQLite + user_id 强隔离
  ├─ Uploads: 本地 uploads，鉴权访问
  └─ Agent: LangChain createAgent
       ├─ ChatOpenAI(OpenAI-compatible baseURL)
       └─ MCP tools
          ├─ web_search
          └─ understand_image
```

## 技术栈

- 前端：React + Vite + TypeScript + react-markdown + rehype-sanitize
- 后端：Node.js 原生 HTTP + TypeScript 小型 Router
- 数据库：SQLite + better-sqlite3
- 认证：argon2id + HttpOnly Cookie Session
- 智能体：LangChain.js `createAgent` + `ChatOpenAI`
- MCP：`@modelcontextprotocol/sdk` stdio client，封装成 LangChain tools
- 部署：Docker Compose，单 Node 进程，挂载 `/data`

## 本地运行

```powershell
cd D:\chat-lite
Copy-Item .env.example .env
npm install
npm run dev:server
```

另开一个终端：

```powershell
cd D:\chat-lite
npm run dev
```

打开：

```text
http://localhost:5173
```

## 必填配置

`.env` 至少配置：

```env
INVITE_CODE=your-private-invite-code
MODEL_API_KEY=your-model-key
MODEL_BASE_URL=https://your-openai-compatible-endpoint/v1
MODEL_NAME=your-model-name
```

本地没有 SMTP 时，验证码会打印到后端控制台。

## MiniMax MCP 配置

需要本机/容器内可执行 `uvx`：

```env
MINIMAX_API_KEY=your-minimax-key
MINIMAX_API_HOST=https://api.minimaxi.com
MINIMAX_MCP_COMMAND=uvx
MINIMAX_MCP_ARGS=minimax-coding-plan-mcp -y
```

Agent 会在需要实时信息时调用 `web_search`，在用户询问上传图片时调用 `understand_image`。

## 验证

```powershell
npm run typecheck
npm run build
```

生产模式：

```powershell
$env:NODE_ENV="production"
$env:PORT="3000"
npm start
```

健康检查：

```text
http://localhost:3000/api/health
```

## 安全原则

- 前端永远不传 `user_id`
- 后端从 session cookie 推导当前用户
- 所有业务 SQL 都带 `user_id`
- session token 只在浏览器保存原文，数据库只存 hash
- 上传图片限制 MIME/大小，文件名随机
- Markdown 使用 `rehype-sanitize`
- API Key 只存在服务端 `.env`
