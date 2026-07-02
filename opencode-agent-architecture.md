# 基于 opencode 工具调用源码的对话式 AI Agent 架构设计

> **本文档原则**
> - 所有架构结论都附带 opencode 源码中的 file:line 引用，可直接定位验证。
> - 仅描述源码真实存在的设计；不存在的特性、文件、字段一律不写。
> - 范围：`packages/opencode/src/` 下与"agent / 工具调用"直接相关的代码。
> - 路径基准：仓库根 `D:\Develop\opencode\`（在 Windows 上也是同一相对路径）。

---

## 1. 文档目的与适用范围

你想"设计一个自己的对话 agent"，最稳的做法不是凭空发明，而是把 opencode 这套已经在生产里跑过的实现拆开，看清楚：

- 它把"对话"和"工具调用"分成了几层？
- 它在哪里强制"工具调用必须真的执行过"？
- 它为什么工具调用率特别高，又是怎么避免模型"假装调了"的？
- 哪些组件是"必须抄"的，哪些是"先别抄"的？

本文档按上述顺序展开。第 4 节是详细组件分析，第 5 节是按优先级排列的"自建实施清单"，第 6 节是"风险提示"。

---

## 2. opencode 工具调用总览

### 2.1 一次"用户发一句话 → agent 行动"的端到端流程

下面这张图描述了一个最小闭环，所有箭头都对应到源码里的真实调用：

```
┌──────────────────────────────────────────────────────────┐
│ 用户输入 (TUI / CLI / HTTP / ACP)                         │
└──────────────────────────┬───────────────────────────────┘
                           ▼
        ┌────────────────────────────────────┐
        │ session/prompt.ts runLoop         │  while (true)
        │ step++; maxSteps = agent.steps    │  prompt.ts:1088, 1178
        │    ?? Infinity                    │
        └────────────────┬───────────────────┘
                         ▼
        ┌────────────────────────────────────┐
        │ session/llm.ts streamText         │  llm.ts:280-353
        │  └ wrapLanguageModel + middleware │
        │  └ experimental_telemetry span    │  llm.ts:344-352
        └────────────────┬───────────────────┘
                         ▼  fullStream
        ┌────────────────────────────────────┐
        │ llm/ai-sdk.ts toLLMEvents          │  ai-sdk.ts:76-286
        │   tool-input-start / tool-call    │
        │   tool-result / tool-error        │
        └────────────────┬───────────────────┘
                         ▼  LLMEvent stream
        ┌────────────────────────────────────┐
        │ session/processor.ts handleEvent   │  processor.ts:276-535
        │  ├ doom-loop 检测                  │  processor.ts:354-378
        │  ├ ensureToolCall / updateToolCall │  processor.ts:214-251
        │  ├ completeToolCall / failToolCall │  processor.ts:160-211
        │  └ step-finish 聚合 cost/tokens    │  processor.ts:433-481
        └────────────────┬───────────────────┘
                         ▼
        ┌────────────────────────────────────┐
        │ session/tools.ts execute wrapper   │  tools.ts:391-412
        │  ├ permission.ask(...)             │  tools.ts:401
        │  ├ decodeUnknownEffect(args)       │  tool.ts:111
        │  ├ Truncate.output(...)            │  tool.ts:135
        │  └ Effect.withSpan("Tool.execute") │  tool.ts:145
        └────────────────┬───────────────────┘
                         ▼
        ┌────────────────────────────────────┐
        │ tool/<name>.ts 真实执行            │
        │  read / write / edit / glob /      │
        │  grep / shell / task / webfetch /  │
        │  websearch / question / todowrite / │
        │  lsp / skill / plan / invalid      │
        └────────────────┬───────────────────┘
                         ▼
        ┌────────────────────────────────────┐
        │ 工具结果 → ToolPart.state          │  processor.ts:160-211
        │ 持久化到 SessionV1 store           │  session.ts:631-645
        │ 重新组装 messages 喂给 LLM 下一轮  │  message-v2.ts:131-415
        └────────────────────────────────────┘
```

### 2.2 四个核心设计原则（贯穿全部组件）

| # | 原则 | 在 opencode 中的实现位置 |
|---|------|--------------------------|
| P1 | **每个 `tool_use` 必须有真实结果落地** | `processor.ts:160-211` 把成功/失败/错误分别写回 `ToolPart.state`；`message-v2.ts:131-415` 投影成 model 看得见的 tool result part |
| P2 | **循环默认无上限，但有 doomsday 兜底** | `prompt.ts:1088` 是 `while (true)`，`prompt.ts:1178` 默认 `Infinity`；唯一兜底是 `processor.ts:29` 的 `DOOM_LOOP_THRESHOLD = 3` |
| P3 | **并行调用是首类公民** | `processor.ts` 用 `Record<string, ToolCall>` 按 `toolCallId` 跟踪所有调用；`tools.ts:401` 的 `ctx.ask` 在每次执行前调用 |
| P4 | **工具描述和系统提示直接鼓励调用** | `tool/glob.txt`、`tool/task.txt` 第 1 条、`agent/generate.txt` 全部明示"proactive / speculative / concurrent" |

---

## 3. 关键证据汇总表（便于查阅）

| 主题 | 关键位置 |
|------|----------|
| 外层主循环 | `packages/opencode/src/session/prompt.ts:1088`（`while (true)`）、`prompt.ts:1178`（`maxSteps = agent.steps ?? Infinity`） |
| Doom-loop 常量 | `packages/opencode/src/session/processor.ts:29`（`DOOM_LOOP_THRESHOLD = 3`） |
| Doom-loop 检测逻辑 | `packages/opencode/src/session/processor.ts:351-378` |
| 工具执行包装 | `packages/opencode/src/tool/tool.ts:99-149`（`wrap`）、`tool.ts:111`（`Schema.decodeUnknownEffect`）、`tool.ts:145`（`Effect.withSpan`） |
| 工具结果持久化 | `packages/opencode/src/session/processor.ts:160-211`（`completeToolCall` / `failToolCall`） |
| 步骤成本/Token 聚合 | `packages/opencode/src/session/processor.ts:436-443` |
| 权限 ask 入口 | `packages/opencode/src/session/tools.ts:391-412`、特别 `tools.ts:401` |
| 权限规则评估 | `packages/opencode/src/permission/index.ts:28-38`（`evaluate`）、`permission/index.ts:67-107`（`Service.ask`）、`permission/index.ts:109-167`（`Service.reply`） |
| 工具注册中心 | `packages/opencode/src/tool/registry.ts:80`（Service）、`registry.ts:218-235`（builtin 列表） |
| Effect Schema → JSON Schema | `packages/opencode/src/tool/json-schema.ts:8-22` |
| 输出截断阈值 | `packages/opencode/src/tool/truncate.ts:15-16`（`MAX_LINES=2000`、`MAX_BYTES=50*1024`）、`truncate.ts:75-83`（用户可覆盖） |
| 截断落盘位置 | `packages/opencode/src/tool/truncation-dir.ts:4`（`<Global.Path.data>/tool-output/`） |
| 子代理 session 创建 | `packages/opencode/src/tool/task.ts:81-158` |
| 子代理消息转发 | `packages/opencode/src/tool/task.ts:160-198`（`runTask`） |
| 并行调用跟踪 | `packages/opencode/src/session/processor.ts:67-75`（`Record<string, ToolCall>`）、`processor.ts:569-573`（`concurrency: "unbounded"`） |
| Provider 注册表 | `packages/opencode/src/provider/provider.ts:107-134`（`BUNDLED_PROVIDERS`） |
| LLM 流包装 | `packages/opencode/src/session/llm.ts:280-353`（`streamText` + `wrapLanguageModel`） |
| AI-SDK 事件适配 | `packages/opencode/src/session/llm/ai-sdk.ts:76-286`（`toLLMEvents`） |
| OpenTelemetry 跨度 | `packages/opencode/src/session/llm.ts:208-222`（`telemetryTracer`）、`llm.ts:344-352`（`experimental_telemetry`）、`tool/tool.ts:145`（`Tool.execute` span） |
| 错误回灌模型 | `packages/opencode/src/tool/tool.ts:24-33`（`InvalidArgumentsError.message`）、`tool/tool.ts:121-128`、`session/llm.ts:296-312`（`experimental_repairToolCall`）、`tool/invalid.ts:9-21` |
| ToolPart 状态机 | `packages/schema/src/v1/session.ts:304-313`（`status ∈ {pending, running, completed, error}`） |
| 会话生命周期 | `packages/opencode/src/session/session.ts:669-691`（`create`）、`session/session.ts:693-733`（`fork`） |

---

## 4. 详细组件设计

### 4.1 Agent 定义与系统提示

#### Agent 的最小契约

`packages/opencode/src/agent/agent.ts` 第 38–56 行定义了 `Info` Schema：

```ts
// packages/opencode/src/agent/agent.ts:38-56
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(...),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),   // <-- 关键：默认无上限
})
```

**设计要点**：
- `mode: "subagent" | "primary" | "all"` 把 agent 显式分成两类：能被 task 工具调用的、只能做主对话的、两者都行。
- `permission: PermissionV1.Ruleset` 是必填字段，**每个 agent 出生时自带一组规则**，这是后面"权限分层"的根基。
- `steps` 是 `optional`，缺省即无限——这就是 opencode"工具调用率高"的第一推动力。

#### 系统提示与"鼓励调用"的话术

`packages/opencode/src/agent/agent.ts:14-18` 引入了 5 个文本片段：

```ts
// packages/opencode/src/agent/agent.ts:14-18
import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
```

`packages/opencode/src/agent/generate.txt` 里有：

- "If the user mentioned or implied that the agent should be used **proactively**, you should include examples of this."
- "Make the agent **proactive** in seeking clarification when needed."

这些不是文案——它们直接喂给 LLM，是"鼓励激进调用"在提示词层的实现。

工具的提示词更激进。`packages/opencode/src/tool/glob.txt` 写：

> "You have the capability to call multiple tools in a single response. **It is always better to speculatively perform multiple searches as a batch that are potentially useful.**"

`packages/opencode/src/tool/task.txt` 第 1 条：

> "Launch multiple agents **concurrently** whenever possible, to maximize performance; to do that, use a single message with multiple tool uses"

**自建怎么抄**：
1. 把 agent 拆成 `primary` / `subagent` 两种模式，分别对应"对话主入口"和"被委派任务的子节点"。
2. `steps` 字段一定要做；但**默认值要慎重**——新手 agent 不要照搬 `Infinity`。
3. 系统提示词里**明示**"优先使用工具"、"并发调用"、"主动澄清"，别让模型"以为不需要调"。

---

### 4.2 ToolRegistry：工具的注册中心

#### 注册中心是 Effect Service

`packages/opencode/src/tool/registry.ts:80` 把 registry 实现成一个 Effect Context Service：

```ts
// packages/opencode/src/tool/registry.ts:80
Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry")
```

#### 工具来源合并

`registry.ts:218-235` 是内置工具的固定列表（顺序敏感）：

```ts
// packages/opencode/src/tool/registry.ts:218-235 (伪代码，结构)
builtin: Tool.Def[] = [
  "invalid",                  // 兜底，永远存在
  "question",                 // 可选：受 flags.client 门控
  "shell", "read", "glob", "grep",
  "edit", "write", "task",
  "fetch", "todo", "search", "skill", "patch",
  "lsp",                      // 可选：flags.experimentalLspTool
  "plan"                      // 可选：flags.experimentalPlanMode && client=="cli"
]
```

**用户/插件自定义工具**通过两条路径注入：
1. **Config-defined**：`registry.ts:173-185` 在每个 config 目录下 glob `{tool,tools}/*.{js,ts}`，动态 import。命名规则：`registry.ts:183`。
2. **Plugin-defined**：`registry.ts:187-192` 把 `plugin.list()` 返回的工具合并进 `custom`。

#### 工具按模型/平台裁剪

`registry.ts:266-306` 的 `tools(input)` 是**最终过滤层**：

- `websearch` 仅在 `webSearchEnabled(providerID, flags)` 为真时出现（`registry.ts:55`）。
- `apply_patch` 仅对 `gpt-*` 模型开放，排除 `oss` 和 `gpt-4`（`registry.ts:272-274`）。
- `edit` / `write` 是 `apply_patch` 的反向（`registry.ts:275`）。
- `task` 的描述会被动态追加当前可用的非 primary agent 列表（`registry.ts:251-264`，`describeTask`）。

最后还有一道 `plugin.trigger("tool.definition", ...)` 钩子（`registry.ts:288`），让插件在工具暴露给 LLM 之前重写 `description` / `parameters` / `jsonSchema`。

**自建怎么抄**：
1. 一定要有一个"工具注册中心"，**别把所有工具散落在业务代码里**。
2. 工具按"内置 + 配置目录 + 插件"三源合并，每源都标注来源方便排错。
3. 最后一道过滤必须存在——**不能把不适配当前模型的工具暴露给 LLM**，否则它会"以为能调"。

---

### 4.3 Effect Schema → JSON Schema 转换

LLM 看不懂 Effect 的 Schema，只能看 JSON Schema。`packages/opencode/src/tool/json-schema.ts` 做了这件事：

```ts
// packages/opencode/src/tool/json-schema.ts:8-22
export function fromSchema(schema: Schema.Top): JSONSchema7 {
  const document = Schema.toJsonSchemaDocument(schema, { additionalProperties: true })
  const result = normalize({ ...document, $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12 })
  const inlined = dropDefinitionsIfResolved(inlineLocalReferences(result))
  return inlined as JSONSchema7
}
```

后处理包含 4 步（`json-schema.ts:28-119`）：
- `normalize(...)` 折叠 `anyOf`、去除冗余 `null`、合并 `allOf`、钳制 integer 到安全范围。
- `inlineLocalReferences(...)` 把 `#/$defs/...` 引用展开。
- `dropDefinitionsIfResolved(...)` 清理空 `$defs`。
- `WeakMap<Schema.Top, JSONSchema7>` 缓存（`json-schema.ts:6`）按 Schema 身份做 key。

工具可以通过 `Tool.Def.jsonSchema` 字段**预先提供** JSON Schema，跳过运行时转换（`tool/tool.ts:55-65` 的 `Def` 接口）：

```ts
// packages/opencode/src/tool/tool.ts:55-65 (关键字段)
parameters: Parameters,                 // Effect Schema.Decoder
jsonSchema?: JSONSchema7,               // 可选预计算
```

**自建怎么抄**：别在每次 LLM 调用时都重新生成 JSON Schema。**缓存 + 预计算**两点必做。

---

### 4.4 主循环：while (true) + maxSteps

这是"工具调用率高"的心脏。

```ts
// packages/opencode/src/session/prompt.ts:1081-1130 (摘要)
const runLoop: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.run")(
  function* (sessionID: SessionID) {
    let structured: unknown
    let step = 0
    while (true) {
      yield* status.set(sessionID, { type: "busy" })
      yield* Effect.logInfo("loop", { "session.id": sessionID, step })
      // ... 读历史 / 调 LLM / 处理事件 / 持久化 ...
      step++
    }
  }
)
```

```ts
// packages/opencode/src/session/prompt.ts:1178-1179
const maxSteps = agent.steps ?? Infinity
const isLastStep = step >= maxSteps
```

**所有退出条件**（`prompt.ts:1081-1340` + `processor.ts:625-681`）：

| 退出原因 | 位置 | 行为 |
|----------|------|------|
| 自然结束 | `prompt.ts:1129` | `lastAssistant.finish` 非 tool-calls 且无新工具调用 → break |
| Compaction 决定停止 | `prompt.ts:1157` | `compaction.process` 返回 `"stop"` → break |
| 结构化输出成功 | `prompt.ts:1287-1291` | `structured !== undefined` → return `"break"` |
| 终结原因非工具调用 | `prompt.ts:1294-1316` | content-filter / structured-fail → return `"break"` |
| Processor 报错 | `prompt.ts:1318` | `processor.process()` 返回 `"stop"`（`processor.ts:678`：`ctx.blocked \|\| ctx.assistantMessage.error`）|
| 步数耗尽 | `prompt.ts:1179, 1280` | 追加 `MAX_STEPS_PROMPT`；下一轮落入自然结束 |
| Compaction 需要 | `processor.ts:677` | 返回 `"compact"`，外层继续 |

**关键观察**：唯一硬上限是 `agent.steps`，缺省即无限。

**自建怎么抄**：
1. **一定要有步数上限**，哪怕很大（比如 50）。`Infinity` 是产品级 agent 才有资格用的默认值。
2. 退出条件要显式枚举：自然结束、错误、拒绝、步数耗尽、压缩触发。每条都要有日志。
3. **不要**用"还有未处理事件就继续"作为唯一退出判断，否则容易卡死。

---

### 4.5 工具执行包装：wrap + decodeUnknownEffect

`packages/opencode/src/tool/tool.ts:99-149` 是所有工具的"统一外衣"：

```ts
// packages/opencode/src/tool/tool.ts:99-129 (摘要)
const decode = Schema.decodeUnknownEffect(toolInfo.parameters)
toolInfo.execute = (args, ctx) =>
  Effect.gen(function* () {
    const decoded = yield* decode(args).pipe(
      Effect.mapError((error) =>
        new InvalidArgumentsError({ tool: id, detail: toolInfo.formatValidationError ? toolInfo.formatValidationError(error) : String(error) })),
    )
    const result = yield* execute(decoded as Schema.Schema.Type<Parameters>, ctx)
    // ...截断...
    return result
  }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs }))
```

四个关键点：
1. **`Schema.decodeUnknownEffect`**（`tool.ts:111`）：每个工具**在初始化时编译一次**参数解析器，运行期复用。
2. **`InvalidArgumentsError`**（`tool.ts:24-33`）：参数不合法时**抛一个面向 LLM 的错误**，而不是 500：

   ```ts
   // packages/opencode/src/tool/tool.ts:24-33
   override get message() {
     return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.\nPlease rewrite the input so it satisfies the expected schema.`
   }
   ```

3. **`Effect.orDie`**（`tool.ts:145`）：所有执行期失败都变成"defect"抛给 AI SDK，由 SDK 触发 `tool-error` 事件回流。
4. **`Effect.withSpan("Tool.execute", ...)`**（`tool.ts:145`）：每个工具调用都是一个 OTel span，属性里有 `tool.name` / `tool.call_id` / `session.id`。

**自建怎么抄**：这是**最值得抄的组件**。三件事都做：
- 工具参数用强类型 Schema 校验（Zod / Effect Schema / JSON Schema 都行）。
- 失败时返回**对 LLM 友好**的错误信息（让它能改）。
- 每个调用加 trace，方便排查"哪一步慢、哪一步错"。

---

### 4.6 Doom-loop 检测

唯一阻止"无限重试"的机制。

```ts
// packages/opencode/src/session/processor.ts:29
const DOOM_LOOP_THRESHOLD = 3
```

```ts
// packages/opencode/src/session/processor.ts:351-378 (摘要)
case "tool-call": {
  ...
  const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)
  if (
    recentParts.length !== DOOM_LOOP_THRESHOLD ||
    !recentParts.every(
      (part) =>
        part.type === "tool" &&
        part.tool === value.name &&
        part.state.status !== "pending" &&
        JSON.stringify(part.state.input) === JSON.stringify(input),
    )
  ) return
  const agent = yield* agents.get(ctx.assistantMessage.agent)
  yield* permission.ask({
    permission: "doom_loop",
    patterns: [value.name],
    sessionID,
    metadata: { tool, input },
    always: [value.name],
    ruleset: agent.permission,
  })
}
```

**机制**：当"最近 3 个 Part"全是"同一个 tool、同一个 input、已结束（不是 pending）"时，触发 `permission.ask("doom_loop", ...)`——交给用户决定，而不是直接熔断。

**自建怎么抄**：
1. 至少要有"同工具、同输入连续 N 次"的检测。N=3 是经验值。
2. 检测到之后**让用户决定**，不要直接 throw——用户可能就是要"再试一次"。

---

### 4.7 消息持久化（ToolPart 状态机）

#### 状态机定义

```ts
// packages/schema/src/v1/session.ts:304-313
state: Schema.Union([
  PendingState,   // status: "pending"
  RunningState,   // status: "running"
  CompletedState, // status: "completed"
  ErrorState,     // status: "error"
])
```

#### 状态转移实现

`packages/opencode/src/session/processor.ts:160-211`：

```ts
// packages/opencode/src/session/processor.ts:160-184 (completeToolCall)
const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (toolCallID: string, output: ToolResultValue) {
  const match = yield* readToolCall(toolCallID)
  if (!match || match.part.state.status !== "running") return false
  yield* session.updatePart({
    ...match.part,
    state: {
      status: "completed",
      input: match.part.state.input,
      output,
      title: toolResultTitle(output),
      metadata: toolResultMetadata(output),
      time: { start: match.part.state.time.start, end: Date.now() },
    },
  })
  yield* settleToolCall(toolCallID)
  return true
})
```

```ts
// packages/opencode/src/session/processor.ts:186-203 (failToolCall)
const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
  ...
  yield* session.updatePart({
    ...match.part,
    state: { status: "error", input: match.part.state.input, error: errorMessage(error), time: { start: match.part.state.time.start, end: Date.now() } },
  })
  if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
    ctx.blocked = ctx.shouldBreak
  }
  ...
})
```

**两个关键点**：
1. **状态写回数据库是同步的**（在 Effect generator 内 `yield*`）。每一次 `updatePart` 都真正落地后才继续。
2. **`cleanup()` 通过 `Effect.ensuring(cleanup())`（`processor.ts:674`）** 兜底——即使循环被打断，未关闭的 part 也会被 finalize。

#### 把 ToolPart 投影回 LLM 看得见的"tool result"

`packages/opencode/src/session/message-v2.ts:131-415` 的 `MessageV2.toModelMessagesEffect`：

- 已完成的 ToolPart → 渲染成 `tool-${name}` UIMessage part，带 `toolCallId: part.callID`（`message-v2.ts:315-323`）。
- 失败的 ToolPart → 同样渲染，但标记 error（`message-v2.ts:325-347`）。

**自建怎么抄**：这是"反幻觉"的硬骨头。**模型下一轮对话里必须看到它上一轮调用的真实结果**（成功文本 / 错误信息），不能凭空捏造。要做到这一点：
- 工具结果必须**持久化**（不能只在内存里）。
- 投影回消息历史时**不能用自然语言改写**——保持原始 `toolCallId` ↔ `tool result` 的对应关系。
- 失败也要写回，模型看到错误才能改。

---

### 4.8 并行工具调用

并行能力由 3 层叠加实现：

1. **AI SDK 支持一次响应里多个 `tool_use` 块**（协议层，OpenAI / Anthropic 都支持）。
2. **`processor.ts` 按 `toolCallId` 跟踪每个调用**：

   ```ts
   // packages/opencode/src/session/processor.ts:67-75 (伪代码)
   toolcalls: Record<string, ToolCall> = {}
   ```

3. **`tools.ts:569-573` 用 `concurrency: "unbounded"`** 跑所有执行。

`packages/opencode/src/tool/glob.txt` 已经在系统提示词里鼓励模型"a single response 多个 tool_use"。

**自建怎么抄**：
- **必须**支持一次响应里多个 tool_use——这是 LLM 利用率最大化的关键。
- 但每个工具调用仍要**单独走权限校验**（不能一个 `ctx.ask` 包多个调用）。
- 并发上限用 `concurrency: "unbounded"` 是激进选择，新手 agent 应该加个软上限（比如 8）。

---

### 4.9 子代理：task 工具

#### 子代理创建

`packages/opencode/src/tool/task.ts:81-158`：

```ts
// packages/opencode/src/tool/task.ts:81-158 (摘要)
TaskTool = Tool.define("task", ...)
subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
...
const childPermission = deriveSubagentSessionPermission({...})
const nextSession = yield* sessions.create({
  parentID: ctx.sessionID,
  title: params.description + " (@<name> subagent)",
  agent: next.name,
  permission: [...childPermission, ...childToolDenies.filter(...)],
})
```

**关键设计**：
- 子 session 通过 `parentID` 与父 session 关联（`task.ts:142-158`）。
- **权限做减法**：`deriveSubagentSessionPermission` + `childToolDenies` 决定子代理**不能用**哪些工具（`task.ts:125-141`）。默认禁止 `todowrite`、`task`、`cfg.experimental.primary_tools`。
- 同样支持 `task_id` 复用已有子 session（`task.ts:121-122`），相当于"续聊"。

#### 消息转发

`packages/opencode/src/tool/task.ts:160-198` 的 `runTask()` 把父消息继承 `variant` 后，调用 `ops.prompt({ sessionID: nextSession.id, agent: next.name, parts })` 启动子代理。

后台模式（`task.ts:202-257`）用 `BackgroundJob.Service` 把任务挂到后台，完成后通过 `notify(nextSession.id)`（`task.ts:215-228`）注入合成的 `task_result` / `task_error` 进父 session。

**自建怎么抄**：
1. 子代理**必须有 parentID**，否则对话历史会断裂。
2. 子代理**必须**有独立权限，且默认**比父代理权限小**（禁止再派生子代理、禁止写操作等）。
3. 子代理的最终回复**必须**回到父代理的下一轮消息里——不能只让 UI 看到。

---

### 4.10 输出截断

工具输出如果太大，会爆 LLM 的上下文窗口。`packages/opencode/src/tool/truncate.ts` 解决了这个问题：

```ts
// packages/opencode/src/tool/truncate.ts:15-16
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024   // 50 KiB
```

```ts
// packages/opencode/src/tool/truncate.ts:75-83
function limits() {
  const cfg = ... // from Config
  return {
    maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
    maxBytes: cfg?.tool_output?.max_bytes ?? MAX_BYTES,
  }
}
```

**算法**（`truncate.ts:85-141`）：
1. 如果 `lines.length <= maxLines && totalBytes <= maxBytes`，原样返回。
2. 否则按 `direction`（"head" / "tail"）逐行累加字节数，**第一次会越界时停止**。
3. 把**完整原文**写到 `TRUNCATION_DIR = <Global.Path.data>/tool-output/tool_<id>`（`tool/truncation-dir.ts:4`）。
4. 返回 `{ content: preview + "...N bytes/lines truncated..." + hint, truncated: true, outputPath: file }`，hint 里会推荐用 `task` 工具委派处理大文件。

**自动应用**：每个工具的输出都经过 `Truncate.Service.output(...)`（`tool/tool.ts:135`），除非工具自己已经在 `metadata.truncated` 里标注过。

**自建怎么抄**：
- 一定要做输出截断，否则 `cat huge.log` 一次就爆上下文。
- 默认值给到 50KB / 2000 行是合理的（Anthropic 4 Sonnet 200K context 仍能装下多轮对话）。
- **完整原文必须落盘**，不能只保留 preview。否则模型一旦要根据全文继续做事就抓瞎。

---

### 4.11 权限系统

#### 规则评估

```ts
// packages/opencode/src/permission/index.ts:28-38
export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  // 1. 扁平化所有 rulesets
  // 2. 找最后一个匹配（wildcard）：permission 匹配 + pattern 匹配
  // 3. 找不到匹配 → 返回 { action: "ask", permission, pattern: "*" }
}
```

**默认行为是 ask**——这是 opencode 的保守选择。

#### Service.ask 流程

`permission/index.ts:67-107`：

```ts
Service.ask(input) =
  for each pattern in request.patterns:
    rule = evaluate(permission, pattern, ruleset, approved)
    if rule.action == "deny": throw DeniedError
    if rule.action == "allow": continue
    else: needsAsk = true
  if needsAsk:
    allocate Deferred<void, RejectedError | CorrectedError>
    publish PermissionV1.Event.Asked
    await deferred
```

#### Service.reply 流程

`permission/index.ts:109-167`：
- `reject` → fail deferred（带 `CorrectedError(feedback)`），级联拒绝同 session 内其他 pending 请求。
- `once` → succeed deferred（不持久化）。
- `always` → 把 `{ permission, pattern, action: "allow" }` 写入 `state.approved`，**后续同类请求自动放行**。

#### 工具调用前的权限闸门

```ts
// packages/opencode/src/session/tools.ts:391-412 (摘要)
item.execute = (args, opts) =>
  Effect.gen(function* () {
    ...
    yield* Effect.gen(function* () {
      yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })   // <-- 闸门
      return yield* Effect.promise(() => execute(args, opts))
    }).pipe(Effect.withSpan("Tool.execute", { ... }))
  })
```

`ctx.ask` 实际调用 `permission.ask(...)`（`tools.ts:78-86`），`ruleset` 是 agent 与 session 的 `Permission.merge(...)`。

**自建怎么抄**：
1. 工具调用前**必须**有权限闸门。哪怕 demo 阶段也要有，否则用户面对的是一个能执行任意 shell 的 agent。
2. 默认 `ask`，不要默认 `allow`。
3. `always` 持久化是必要的体验优化——不要每次 `grep` 都问用户。

---

### 4.12 Provider 抽象 + LLM 流

#### Provider 注册

```ts
// packages/opencode/src/provider/provider.ts:107-134 (摘要)
const BUNDLED_PROVIDERS: Record<string, () => Promise<(opts: any) => BundledSDK>> = {
  "@ai-sdk/anthropic": () => import("@ai-sdk/anthropic").then((m) => m.createAnthropic),
  "@ai-sdk/openai": () => import("@ai-sdk/openai").then((m) => m.createOpenAI),
  "@ai-sdk/openai-compatible": () => import("@ai-sdk/openai-compatible").then((m) => m.createOpenAICompatible),
  // ... 20+ 个
}
```

每个 provider 还有 `custom(dep)`（`provider.ts:168-950`）做模型特定处理：Anthropic headers、Vertex auth、Bedrock region、Copilot 路由……

#### LLM 流包装

```ts
// packages/opencode/src/session/llm.ts:280-353 (摘要)
result: streamText({
  ...
  tools: prepared.tools,
  toolChoice: input.toolChoice,
  maxOutputTokens: prepared.params.maxOutputTokens,
  abortSignal: input.abort,
  maxRetries: input.retries ?? 0,
  messages: prepared.messages,
  model: wrapLanguageModel({ model: language, middleware: [/* transformParams */] }),
  experimental_telemetry: {
    isEnabled: cfg.experimental?.openTelemetry,
    functionId: "session.llm",
    tracer: telemetryTracer,
    metadata: { userId: cfg.username ?? "unknown", sessionId: input.sessionID },
  },
})
```

#### AI-SDK 事件 → LLMEvent

`packages/opencode/src/session/llm/ai-sdk.ts:76-286` 的 `toLLMEvents` 把 ai-sdk 的 fullStream 事件翻译成 opencode 自己的 `LLMEvent` 联合类型：

| ai-sdk 事件 | LLMEvent | ai-sdk.ts 位置 |
|-------------|----------|----------------|
| `tool-input-start` | `toolInputStart` | `:190-200` |
| `tool-input-delta` | `toolInputDelta` | `:202-209` |
| `tool-input-end` | `toolInputEnd` | `:211-218` |
| `tool-call` | `toolCall` | `:220-232` |
| `tool-result` | `toolResult` | `:234-247` |
| `tool-error` | `toolError` | `:249-262` |
| `start-step` / `finish-step` | `stepStart` / `stepFinish` | `:84-109` |
| `text-*` / `reasoning-*` | `textStart/Delta/End` / `reasoning*` | `:126-188` |

`toolCallId` 是贯穿全程的 key：
- AI SDK stream 的 `tool-input-start.id` / `tool-call.toolCallId` → `LLMEvent.toolCall.id`（`ai-sdk.ts:192-200, 220-232`）。
- Processor 用 `ctx.toolcalls[input.id]`（`processor.ts:214-251`）按 id 跟踪。
- 下一轮 `message-v2.ts:131-415` 把完成的 ToolPart 渲染成带 `toolCallId: part.callID` 的 tool result（`message-v2.ts:315-323`）。

**自建怎么抄**：
1. 把"模型 API 协议"和"agent 内部事件"**分开**——不要让业务逻辑直接处理 provider 的流格式。
2. 每个流事件必须带稳定 id（`toolCallId`），否则并行调用无法跟踪。
3. OpenTelemetry 跨度从最外层 LLM 调用就开始，每个工具调用再开一个子 span。

---

### 4.13 成本与 Token 计量

#### 累积位置

```ts
// packages/opencode/src/session/processor.ts:433-454 (摘要)
case "step-finish": {
  const usage = Session.getUsage({ model: ctx.model, usage: value.usage ?? new Usage({}), metadata: value.providerMetadata })
  ctx.assistantMessage.finish = value.reason
  ctx.assistantMessage.cost += usage.cost           // 累加
  ctx.assistantMessage.tokens = usage.tokens        // 覆盖（每步最新值）
  yield* session.updatePart({ ..., tokens: usage.tokens, cost: usage.cost })
  yield* session.updateMessage(ctx.assistantMessage)
}
```

#### Cost 计算

`packages/opencode/src/session/session.ts:338-407` 的 `Session.getUsage`：
- 规范化 cache write tokens（Anthropic / Vertex / Bedrock / Venice 各家命名不同）。
- 应用 `cost.tiers` 和 `experimentalOver200K`（200K 以上的费率梯度）。
- 对 Copilot 走 `totalNanoAiu` 路径（`ai-sdk.ts:30-42`）。

**自建怎么抄**：
1. 每个 step 都要把 `usage` 落地（`tokens` + `cost`），否则用户看不到自己花了多少钱。
2. `cost` 是累加，`tokens` 是覆盖——这点容易被搞反。
3. cache tokens 一定要单独统计，否则会算错账。

---

### 4.14 错误反馈给模型

完整的"错误回流"链路有 4 处：

| 错误来源 | 反馈方式 | 位置 |
|----------|----------|------|
| 参数 schema 校验失败 | `InvalidArgumentsError.message` 直接写回 tool result | `tool/tool.ts:24-33, 121-128` |
| AI SDK repair 失败（工具名/参数都不可救） | 把失败调用改写成 `toolName: "invalid"`，input 是 `{ tool, error }` | `session/llm.ts:296-312` |
| `invalid` 工具被调用 | 返回 `"The arguments provided to the tool are invalid: ..."` | `tool/invalid.ts:9-21` |
| 工具执行抛异常 | `Effect.orDie` 让其变 defect → AI SDK 触发 `tool-error` 事件 → `processor.ts:414-417` → `failToolCall` | `tool/tool.ts:145`, `session/processor.ts:381-411` |

**特别要点**：错误信息必须**对 LLM 可读**——告诉它"哪里错了、下次怎么改"。`InvalidArgumentsError` 是范本：

```
The {tool} tool was called with invalid arguments: {detail}.
Please rewrite the input so it satisfies the expected schema.
```

**自建怎么抄**：模型"幻觉调用"的最大成因就是**错误回流做得不对**——它不知道上次哪里失败，所以下次瞎试。**必须**做到：
- 工具错误有明确的 tool result 回流（不是抛 500 出去）。
- 错误信息包含"错在哪 + 怎么改"。
- 区分"参数错"和"执行错"，前者让模型改 input，后者告诉模型换策略。

---

### 4.15 工具契约（Def 接口）

`packages/opencode/src/tool/tool.ts:55-65` 的 `Tool.Def` 是工具作者唯一要实现的接口：

```ts
interface Def<Parameters, Result> {
  id: string
  description: string
  parameters: Parameters                                  // Effect Schema.Decoder
  jsonSchema?: JSONSchema7                                // 可选预计算
  execute(args, ctx): Effect<Result, ...>                 // 实际执行
}
```

每个工具文件（`packages/opencode/src/tool/*.ts`）都用 `Tool.define(id, ...)` 注册，例如 `tool/lsp.ts:37`、`tool/task.ts:81`、`tool/question.ts:14`。

**自建怎么抄**：工具作者**只需要关心 3 件事**：id、参数 schema、execute 函数。所有横切关注点（权限、截断、trace、参数校验）由 `wrap()`（`tool/tool.ts:99-149`）自动加。

---

## 5. 自建 agent 的实施清单（按优先级）

下面这份清单按"投资回报"排序。先做第 1 步，再做第 2 步。**不要跳着做。**

### 阶段 1：能跑起来的最小闭环（M1 目标）

| # | 任务 | 参考实现 |
|---|------|----------|
| 1 | 定义工具接口：`{ id, description, parameters: Zod/JSONSchema, execute(args, ctx) }` | `tool/tool.ts:55-65` |
| 2 | 实现 `wrap(tool)`：参数校验 + 错误信息格式化 + 截断 + trace span | `tool/tool.ts:99-149` |
| 3 | 实现 Effect Schema → JSON Schema 转换（或直接用 Zod） | `tool/json-schema.ts:8-22` |
| 4 | 写"主循环"：`while (step < MAX_STEPS) { stream → 解析 tool_use → 执行 → 拼回历史 → 持久化 }` | `prompt.ts:1081-1340` |
| 5 | 持久化消息：每条 assistant 消息 + 每个 ToolPart 都要落库；状态机 pending → running → completed/error | `processor.ts:160-211`, `schema/v1/session.ts:304-313` |
| 6 | 把 ToolPart 投影回模型看得见的 tool result（保留 `toolCallId` ↔ result 对应关系） | `message-v2.ts:131-415` |

**M1 通过标准**：跑通"用户问 → agent 调 read → 把文件内容回灌 → agent 回答"。

### 阶段 2：反幻觉（M2 目标）

| # | 任务 | 参考实现 |
|---|------|----------|
| 7 | 工具错误必须以"对 LLM 友好"的文字回流，不抛 HTTP 500 | `tool/tool.ts:24-33` |
| 8 | 失败/拒绝的 tool 也要写回历史（让模型知道失败了） | `processor.ts:186-203` |
| 9 | 加 doom-loop 检测（同一工具同输入连续 N 次 → 询问用户） | `processor.ts:351-378` |
| 10 | 输出截断：默认 50KB / 2000 行；落盘完整原文 | `truncate.ts:15-16, 85-141` |
| 11 | 权限闸门：工具调用前问一次；默认 ask | `permission/index.ts:28-107`, `tools.ts:401` |

### 阶段 3：高工具调用率（M3 目标）

| # | 任务 | 参考实现 |
|---|------|----------|
| 12 | 并行 tool_use 支持：按 `toolCallId` 跟踪，并发执行 | `processor.ts:67-75`, `ai-sdk.ts:190-247` |
| 13 | 系统提示词明示："优先使用工具 / 并发调用 / 主动澄清" | `tool/glob.txt`, `tool/task.txt`, `agent/generate.txt` |
| 14 | 工具描述短小、有动作性（避免"可选 / 建议 / 也可以"这类弱词） | `tool/glob.txt` |
| 15 | 每个工具调用都有 OTel span（调试用） | `tool/tool.ts:145`, `llm.ts:344-352` |

### 阶段 4：可扩展（M4 目标）

| # | 任务 | 参考实现 |
|---|------|----------|
| 16 | 子代理：parentID 关联 + 独立权限 + 消息回流 | `tool/task.ts:81-198` |
| 17 | 工具注册中心：内置 + 配置目录 + 插件三源合并 | `tool/registry.ts:80, 173-235` |
| 18 | Provider 抽象：每个 provider 一个动态 import；统一 `streamText` 入口 | `provider/provider.ts:107-134`, `llm.ts:280-353` |
| 19 | 成本/Token 累计到消息级 | `processor.ts:436-443` |
| 20 | Session fork / resume | `session/session.ts:669-733` |

---

## 6. 不要照搬的部分（风险提示）

下面这些是 opencode 选过的，但**不适合自建 agent 起步阶段照抄**：

| 设计 | 风险 | 自建建议 |
|------|------|----------|
| `maxSteps = agent.steps ?? Infinity`（`prompt.ts:1178`） | token 失控、单次对话可能烧光预算 | 默认给上限（如 30），按 agent 类型分级 |
| `{ concurrency: "unbounded" }`（`processor.ts:569-573`） | 50 个并行 read 会把本地 IO 打爆 | 加软上限（如 8），可配 |
| 子代理默认无 `task` 权限（`task.ts:125-141`） | 配置错会导致子代理死锁 | 文档化权限矩阵 |
| ToolPart 状态机 4 个状态（pending/running/completed/error） | 实现复杂，状态机不对齐会导致消息不一致 | M1 阶段可简化成"已完成 / 未完成" |
| 自动 `apply_patch` 模型特化（`registry.ts:272-274`） | 模型白名单维护成本高 | 先不支持，等真用上再加 |
| `provider.ts:168-950` 的 `custom(dep)` 800 行定制 | 维护负担大 | 用 AI SDK 的统一抽象，先不支持私有化定制 |
| `compaction` 自动摘要历史（`prompt.ts:1150-1158`） | 摘要错会丢上下文 | 自建 agent 优先靠"截断 + 提醒"，再考虑摘要 |
| 完整 OTel 集成 | 需要 OpenTelemetry collector 配合 | M3 阶段再开 `experimental.openTelemetry` |

---

## 7. 证据索引（按文件分组）

### 7.1 `packages/opencode/src/session/`

- `prompt.ts:1081-1130` — `runLoop` 主循环
- `prompt.ts:1088` — `while (true)`
- `prompt.ts:1178` — `maxSteps = agent.steps ?? Infinity`
- `prompt.ts:1179` — `isLastStep = step >= maxSteps`
- `prompt.ts:1280` — 步数耗尽追加 `MAX_STEPS_PROMPT`
- `prompt.ts:1129, 1157, 1287-1291, 1294-1316, 1318, 1329-1334` — 退出条件
- `prompt.ts:1271-1285` — 内部 `processor.process()`
- `processor.ts:29` — `DOOM_LOOP_THRESHOLD = 3`
- `processor.ts:67-75` — `toolcalls: Record<string, ToolCall>`
- `processor.ts:160-184` — `completeToolCall`
- `processor.ts:186-203` — `failToolCall`
- `processor.ts:214-251` — `ensureToolCall`
- `processor.ts:329-378` — `tool-call` 处理（含 doom-loop）
- `processor.ts:381-411` — `tool-result` 处理
- `processor.ts:414-417` — `tool-error` 处理
- `processor.ts:422-431` — `step-start` 处理
- `processor.ts:433-481` — `step-finish` 处理（cost/tokens 聚合）
- `processor.ts:556, 562-565, 581-594` — `cleanup()` finalization
- `processor.ts:625-681` — `process()` 主入口
- `processor.ts:674` — `Effect.ensuring(cleanup())`
- `processor.ts:678` — 返回 `"stop"` 条件
- `llm.ts:208-222` — `telemetryTracer`
- `llm.ts:280-353` — `streamText` + `wrapLanguageModel` + `experimental_telemetry`
- `llm.ts:296-312` — `experimental_repairToolCall`
- `llm.ts:357-381` — `LLM.stream(...)`
- `llm/ai-sdk.ts:76-286` — `toLLMEvents` 完整 switch
- `llm/ai-sdk.ts:190-200` — `tool-input-start`
- `llm/ai-sdk.ts:202-209` — `tool-input-delta`
- `llm/ai-sdk.ts:211-218` — `tool-input-end`
- `llm/ai-sdk.ts:220-232` — `tool-call`
- `llm/ai-sdk.ts:234-247` — `tool-result`
- `llm/ai-sdk.ts:249-262` — `tool-error`
- `tools.ts:78-86` — `context()` 构造 `ctx.ask`
- `tools.ts:89-130` — 内置工具 → ai-sdk Tool 转换
- `tools.ts:391-412` — `item.execute` 包装（`ctx.ask` 闸门）
- `session.ts:338-407` — `Session.getUsage`
- `session.ts:415-474` — `Session.Interface`
- `session.ts:631-645` — `updateMessage/updatePart`
- `session.ts:669-691` — `Session.create`
- `session.ts:693-733` — `Session.fork`

### 7.2 `packages/opencode/src/tool/`

- `tool.ts:24-33` — `InvalidArgumentsError.message`
- `tool.ts:55-65` — `Tool.Def` 接口
- `tool.ts:99-149` — `wrap()` 工具包装
- `tool.ts:111` — `Schema.decodeUnknownEffect`
- `tool.ts:121-128` — `decode(args).pipe(Effect.mapError(...))`
- `tool.ts:135` — `Truncate.Service.output(...)`
- `tool.ts:145` — `Effect.withSpan("Tool.execute")`
- `tool.ts:151-169` — `define()` 注册
- `registry.ts:55` — `webSearchEnabled`
- `registry.ts:80` — `ToolRegistry` Service
- `registry.ts:113-169` — `fromPlugin`（插件工具合并）
- `registry.ts:173-192` — config-defined + plugin-defined tools
- `registry.ts:195` — `question` 工具门控
- `registry.ts:218-235` — builtin 列表
- `registry.ts:251-264` — `describeTask`
- `registry.ts:266-306` — `tools(input)` 过滤
- `registry.ts:288` — `plugin.trigger("tool.definition")`
- `registry.ts:393` — `LayerNode` 导出
- `json-schema.ts:6` — `WeakMap` 缓存
- `json-schema.ts:8-22` — `fromSchema`
- `json-schema.ts:28-119` — `normalize` 等后处理
- `truncate.ts:13-16` — `RETENTION`、`MAX_LINES`、`MAX_BYTES`
- `truncate.ts:75-83` — `limits()` 用户可覆盖
- `truncate.ts:85-141` — `output()` 算法
- `truncate.ts:143-148` — 清理任务
- `truncation-dir.ts:4` — `TRUNCATION_DIR`
- `task.ts:64-79` — `renderOutput`
- `task.ts:81-158` — `TaskTool.define`（子 session 创建）
- `task.ts:160-198` — `runTask()` 消息转发
- `task.ts:202-257` — 后台模式
- `task.txt` — 工具描述（鼓励并发子代理）
- `lsp.ts:11-21` — 9 个 LSP 操作
- `lsp.ts:23-35` — `Parameters` Schema
- `lsp.ts:37-113` — `LspTool.define`
- `question.ts:14` — `QuestionTool.define`
- `todo.ts:14` — `TodoWriteTool.define`
- `webfetch.ts:24` — `WebFetchTool.define`
- `websearch.ts:99` — `WebSearchTool`
- `invalid.ts:9-21` — `InvalidTool`
- `mcp-websearch.ts:1-7, 30-41, 69-95` — HTTP JSON-RPC MCP 客户端

### 7.3 `packages/opencode/src/permission/`

- `index.ts:28-38` — `evaluate(permission, pattern, ...rulesets)`
- `index.ts:49` — `state.approved`
- `index.ts:67-107` — `Service.ask`
- `index.ts:109-167` — `Service.reply`

### 7.4 `packages/opencode/src/provider/`

- `provider.ts:37-83` — `wrapSSE`
- `provider.ts:107-134` — `BUNDLED_PROVIDERS`
- `provider.ts:168-950` — `custom(dep)` 私有化定制
- `provider.ts:1188-1237` — `fromModelsDevModel`
- `provider.ts:1239-1271` — `fromModelsDevProvider`
- `provider.ts:1639-1771` — `resolveSDK`
- `provider.ts:1801-1830` — `getLanguage`
- `provider.ts:1971-1975` — `Provider.node`

### 7.5 `packages/opencode/src/agent/`

- `agent.ts:14-18` — 5 个 prompt 文件 import
- `agent.ts:38-56` — `Info` Schema（含 `steps`、`permission`、`mode`）
- `agent.ts:80-90` — `Interface`（`get` / `list` / `defaultInfo` / `generate`）
- `generate.txt` — 生成 agent 时的指导（proactive）
- `prompt/compaction.txt`, `prompt/explore.txt`, `prompt/summary.txt`, `prompt/title.txt` — 内置 agent 提示词

### 7.6 `packages/schema/src/v1/session.ts`

- `session-v1.ts:104` — `text` Part
- `session-v1.ts:120` — `reasoning` Part
- `session-v1.ts:173` — `file` Part
- `session-v1.ts:183` — `agent` Part
- `session-v1.ts:197` — `compaction` Part
- `session-v1.ts:206` — `subtask` Part
- `session-v1.ts:222` — `retry` Part
- `session-v1.ts:235` — `step-start` Part
- `session-v1.ts:242` — `step-finish` Part
- `session-v1.ts:304-313` — `ToolPart.state.status` 状态机
- `session-v1.ts:317` — `ToolPart` 定义
- `session-v1.ts:357-370` — `Part` 联合类型 + `discriminator: "type"`

---

## 8. 一句话总结

opencode 的工具调用架构 = **严格的状态机持久化** + **按 id 跟踪的并行调用** + **子代理递归** + **系统提示词直接鼓励调用**。它的高调用率是设计选择，不是 bug。

自建时按"先跑通 M1 → 反幻觉 M2 → 高调用率 M3 → 可扩展 M4"的顺序，**阶段 1 的 6 步做完之前不要碰阶段 3**，否则会一边调 bug 一边被 token 账单教育。

> **最后一句**：`maxSteps ?? Infinity` 是产品级 agent 的特权，自建阶段请默认给上限。