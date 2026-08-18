# CSV/XLSX 文件处理与子Agent工作区设计记录

> 状态：仅完成讨论和方案设计，尚未实现。
>
> 最后整理：2026-08-16
>
> 目标：让后续会话可以直接理解 CSV/XLSX 文件处理、表格分析LLM循环、会话工作区、沙箱和工件管理的完整讨论，不把设计方案误认为已经存在的代码。

## 1. 最终方向

推荐采用“主Agent + 专用表格分析工具 + 内部有限LLM循环 + 隔离执行环境 + 确定性验证器”的组合：

```text
主Agent
  -> 调用一个表格分析工具
      -> 校验文件和权限
      -> 创建或打开当前会话工作区
      -> 分析LLM生成Python代码
      -> 沙箱执行代码
      -> 读取结构化执行结果
      -> 确定性验证输出
      -> 失败时有限次数修复并重试
      -> 保存工件并返回结构化结果
  -> 主Agent继续回答用户
```

这里的“内部LLM循环”不是复制完整的主AgentLoop，也不是让第二个LLM单独把日志改写成自然语言。它是一个任务专用的、有限次数的：

```text
生成代码 -> 执行 -> 验证 -> 修复
```

推荐的默认重试次数为 1 到 3 次，具体值实现时再确定。不能无限循环，也不能因为模型说“看起来成功”就直接结束。

## 2. 两个原始方案的判断

### 方案A：工具内置子Agent循环

主Agent调用工具后，工具内部的子Agent接收文件引用和元信息，编写Python，调用沙箱运行，读取日志和验证结果，必要时继续修改代码，直到达到成功条件，再把结果交给主Agent。

这是两个方案中更合理的方向，但需要做以下改造：

- 子Agent应该是“表格分析Agent”，不是一个拥有主Agent全部能力的通用Agent。
- 子Agent只拥有表格任务所需的少量工具，例如读取元信息、执行代码、读取执行结果、检查工件。
- 成功条件由机器验证字段和确定性检查共同决定，不能只由LLM主观判断。
- 子Agent的代码、日志、上下文和计数都必须与主聊天上下文隔离。
- 主Agent只接收摘要、事实、验证结果和工件引用，不接收完整代码和完整日志。

方案A的优点：

- 主Agent只需要处理一个高层表格工具，主对话上下文不会被大量代码和日志污染。
- 分析代码的生成、执行、修复逻辑集中在表格能力内部。
- 可以在工具内部设置独立的尝试次数、执行超时和资源限制。
- 后续可以把独立验证Agent作为可选能力加入，而不改变主聊天协议。

方案A的风险：

- 如果直接复用完整主AgentLoop，会把RAG、图片工具、最终回答控制、SSE、Prompt Cache和会话上下文一起嵌套进去，复杂度和故障面都会明显增加。
- 内部每次模型调用都需要纳入usage、诊断、取消和错误处理，否则会出现成本统计和失败状态不一致。
- 子Agent必须有硬性最大循环次数，不能让“直到满意”为无限条件。

### 方案B：一个LLM写代码，另一个LLM整理日志

这个方案不建议按原样采用。

主要问题：

- 日志整理不等于结果验证。第二个LLM可能把“程序退出码为0”误判为“业务结果正确”。
- 每次任务至少增加一次LLM调用，成本和延迟更高。
- 日志被截断后，第二个LLM可能在缺少关键上下文时编造结论。
- 代码、日志、文件结果和业务要求之间没有天然的结构化契约。

如果把第二个LLM从“日志整理器”改成“独立验证器”，并且只在复杂或不确定任务中调用，方案B可以变成有价值的混合方案：

```text
分析LLM -> 沙箱 -> 确定性验证
                    -> 仍然不确定时才调用验证LLM
```

普通任务不需要第二个LLM。

## 3. 网络和开源实践的共识

检索到的官方和开源实践并不是简单的A或B二选一，较成熟的结构通常是两层：

```text
外层主Agent/Graph
  -> 数据分析子Agent
      -> 生成代码 -> 执行 -> 解析 -> 有界修复
          -> sandbox/kernel
```

重要参考：

- [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)：模型提出工具调用，宿主执行，再把工具结果交回模型。
- [OpenAI Code Interpreter](https://developers.openai.com/api/docs/guides/tools-code-interpreter)：代码在隔离容器中执行，而不是直接在Agent宿主机执行。
- [Anthropic Tool Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works)：工具调用和工具结果是明确的消息边界。
- [Anthropic Code Execution](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool)：代码执行使用隔离环境，并返回结构化执行结果。
- [LangChain Multi-agent](https://docs.langchain.com/oss/python/langchain/multi-agent)：子Agent适合上下文隔离、专业能力和权限隔离，但会增加调用成本和延迟。
- [OpenHands](https://github.com/OpenHands/software-agent-sdk)：Agent通过Action/Observation与运行时交互，命令结果包含退出码、标准输出、标准错误和超时信息。
- [DeepAgents subagents](https://github.com/langchain-ai/deepagents)：大工具结果可以落盘，模型只接收预览和路径，而不是完整内容。
- [TaskWeaver](https://github.com/microsoft/TaskWeaver)：数据分析Agent使用持久执行环境，并区分代码、执行状态、工件和结构化结果。
- [PandasAI](https://github.com/sinaptik-ai/pandas-ai)：典型的代码生成、执行、解析和失败重试闭环。

共同原则：

1. 模型只负责推理和生成动作。
2. 宿主负责权限、文件访问和工具执行。
3. 沙箱负责代码执行隔离。
4. 验证器负责判断执行是否真的满足任务。
5. 工件系统负责保存大文件、完整日志和可下载结果。

## 4. 当前 chat-lite 的已确认事实

这些是当前代码事实，不是未来设计：

- 主聊天入口调用手写的`runAgentLoop`，见 `src/server/modules/chat/chat.ts` 和 `src/server/modules/chat/engine/agent-loop.ts`。
- AgentLoop有工具决策阶段和最终回答阶段，工具调用由静态Tool Registry管理。
- 当前工具主要是 `web_search`、`text_to_image`、`image_edit`、`view_image`，见 `src/server/modules/chat/engine/tool-def.ts` 和 `tool-registry.ts`。
- 当前前端上传器按图片设计，后端上传校验只接受JPEG、PNG和WebP。
- Busboy默认单文件上传，并且默认大小约为5MB；当前上传链路会先把文件收进内存。
- 当前聊天附件绑定要求图片MIME类型，并且按用户和会话做权限限制。
- 当前附件存储主要位于用户级上传目录，不是表格分析专用工作区。
- 当前AgentLoop没有通用Python执行器、代码运行工具、任务Worker或沙箱。
- Docker中的Python和uvx目前用于部署依赖和MCP，不代表已经存在安全代码执行边界。
- 当前模型重试由 `src/server/modules/chat/engine/model-retry.ts` 负责，后续内部分析LLM调用应复用其原则，但不能绕过usage和诊断记录。

因此，当前不应该直接增加一个“通用代码执行Agent平台”。应先建立表格文件、会话工作区、工件和验证的最小边界。

## 5. 会话工作区设计

### 5.1 工作区归属

用户所说的“session”应对应当前持久聊天会话的 `conversationId`，而不是一次HTTP请求、一次SSE连接或一次AgentLoop调用。

推荐：

```text
一个conversationId -> 一个持久工作区
一次分析任务       -> 一个runId子目录
一次代码尝试       -> 一个attempt子目录
```

建议的逻辑目录结构：

```text
data/workspaces/<userId>/<conversationId>/
  manifest.json
  input/
  runs/
    <runId>/
      attempt-001/
        generated_code.py
        stdout.txt
        stderr.txt
        validation.json
      attempt-002/
        generated_code.py
        stdout.txt
        stderr.txt
        validation.json
  output/
    <artifact files>
  tmp/
```

实际物理路径不应直接暴露给LLM。

### 5.2 输入、输出和工件

- `input/`保存经过权限校验的输入文件副本，或者保存服务端生成的受控引用。
- 输入文件默认只读，不能让生成代码修改原始上传文件。
- `output/`保存用户可以下载的最终CSV、XLSX、图表、报告或Notebook。
- `runs/`保存代码、每次尝试的结构化状态和调试材料。
- `tmp/`只保存执行期间的临时文件，任务结束后清理。
- `manifest.json`记录attachmentId、原始文件名、MIME、大小、SHA-256、工作表和工件关系。
- 工件下载必须重新校验 `userId + conversationId + artifactId`，不能只凭文件名。

不建议直接复制用户输入文件的原始文件名作为磁盘路径。应使用服务端生成的安全文件名，原始名称只放在元数据中。

### 5.3 生命周期

- 第一次处理表格时按需创建工作区。
- 会话后续消息可以继续读取该会话此前生成的工件。
- 同一会话的每个分析任务使用独立runId，避免覆盖正在使用的文件。
- 删除会话时清理该会话的持久工作区和工件。
- 临时运行目录和失败尝试可以按TTL清理。
- 工作区本身不是沙箱；它只是持久化文件层。

必须区分：

```text
会话工作区 = 持久化输入、输出和分析产物
代码沙箱   = 临时隔离执行环境
```

沙箱只临时挂载当前会话工作区中明确授权的目录，不能挂载整个`data/`或宿主机根目录。

## 6. 推荐的内部分析循环

主Agent调用高层表格工具时，传入的信息应该是：

- `attachmentId`或受控文件引用；
- 用户的自然语言任务；
- 服务端生成的文件元信息；
- 当前`conversationId`和`runId`上下文；
- 当前工作区的虚拟路径或工件引用。

不能让主Agent或内部LLM直接传任意绝对路径。

内部循环建议如下：

1. 服务端验证用户、会话、附件归属和文件类型。
2. 生成文件元信息和有限预览，不把完整文件内容拼进Prompt。
3. 分析LLM生成代码和预期验证条件。
4. 沙箱以只读输入和可写输出运行代码。
5. 宿主读取退出码、标准输出、标准错误、生成文件和运行时长。
6. 确定性验证器检查结果格式、文件可读性、列名、行数、类型和任务要求。
7. 如果失败，把结构化错误和受限日志交给同一个分析LLM修复。
8. 达到最大尝试次数后停止，并返回明确失败状态。
9. 成功后保存工件，返回摘要和工件引用给主Agent。

“代码执行成功”和“业务结果正确”必须分开：

```text
exit_code == 0
不等于
结果满足用户要求
```

## 7. CSV处理边界

CSV没有可靠的文件魔数，不能只靠Content-Type判断。至少需要综合检查：

- 扩展名和用户声明的MIME；
- UTF-8或UTF-8 BOM等允许编码；
- 分隔符、引号和换行结构；
- 单行长度、总行数和列数；
- 编码错误是否应该直接失败，而不是静默替换；
- 是否包含超大字段或异常嵌套引号。

分析大CSV时应支持分块读取，例如pandas的`chunksize`、`nrows`和`usecols`。不能把`low_memory=True`误认为已经提供了严格的内存上限。

CSV中以`=`, `+`, `-`, `@`开头的字段可能在Excel或LibreOffice中被解释为公式。读取CSV通常不会直接执行它们，但重新导出时必须按目标软件规则做公式注入防护。

## 8. XLSX及其他Excel格式边界

初版建议优先支持：

- `.csv`
- `.xlsx`

后续再评估：

- `.xls`
- `.xlsb`
- `.xlsm`
- `.xltx`和`.xltm`

推荐能力边界：

- `pandas`适合表格分析和批量读取。
- `openpyxl`适合读取工作表、单元格、公式文本和工作簿元数据。
- 大工作簿可使用`read_only=True`，但仍要设置服务端自己的资源上限。
- `data_only=True`读取的是Excel最近保存的缓存值，不是服务端重新计算的权威结果。
- `keep_vba`只表示保留VBA元素，不是安全控制。
- 初版默认拒绝或隔离宏启用文件、外部链接和需要刷新外部数据的工作簿。
- 不执行VBA，不刷新外部链接，不访问超链接或`file://`、UNC、HTTP等外部目标。
- 不应该无条件读取所有工作表；默认先读取元信息，再按任务读取指定工作表和范围。
- 隐藏工作表、定义名称、批注、图表和对象中的文本也必须视为不可信数据。

`openpyxl`默认不提供完整的XML资源耗尽防护，因此OOXML压缩包需要额外限制压缩后大小、entry数量、压缩比、工作表数量和单元格规模。

## 9. 文件和表格内容的安全规则

CSV/XLSX内容是数据，不是Agent指令。表头、单元格、批注、隐藏工作表、文件名和解析错误文本都可能包含Prompt Injection。

默认禁止：

- 根据单元格内容调用其他工具；
- 根据表格内容改变系统提示词或权限；
- 执行单元格中的Python、Shell、SQL或URL请求；
- 执行VBA或宏；
- 刷新外部链接或访问超链接；
- 把API密钥、宿主路径或环境变量注入生成代码。

上传校验至少应包含：

- 扩展名allowlist；
- MIME作为辅助信号，不能单独信任；
- CSV结构检查；
- XLSX ZIP和OOXML结构检查；
- 原始字节数、解压后字节数、entry数量和压缩比限制；
- 行数、列数、工作表数、单元格长度和公式数量限制；
- 用户、会话和附件的授权检查。

## 10. 沙箱边界

代码执行不应发生在Node主进程，也不应直接发生在当前聊天容器的普通工作目录中。

沙箱至少需要：

- 非特权用户；
- 每个run独立临时目录；
- 只挂载当前任务需要的输入和输出目录；
- 默认无网络出口；
- 不挂载宿主机根目录、Docker socket或整个`data/`；
- 不注入API密钥、数据库密码或完整环境变量；
- CPU、内存、磁盘、进程数和墙钟时间限制；
- 超时后杀掉整个进程组并清理临时目录；
- 失败时不通过更换解析器或无限重试绕过限制。

如果将来需要LibreOffice重新计算、渲染工作簿或处理宏，隔离要求会更高，不能把普通Python子进程当作足够的安全边界。

## 11. 日志和工件返回协议

不应该把完整stdout/stderr直接放进聊天上下文。推荐返回如下结构：

```json
{
  "status": "succeeded",
  "summary": "...",
  "facts": [],
  "validation": {
    "passed": true,
    "checks": []
  },
  "artifacts": [
    {
      "id": "...",
      "name": "cleaned.xlsx",
      "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "size": 12345,
      "sha256": "..."
    }
  ],
  "execution": {
    "attempts": 2,
    "exit_code": 0,
    "duration_ms": 4200
  },
  "logs": {
    "preview": "...",
    "truncated": true,
    "artifact_id": "full-log-id"
  }
}
```

模型上下文只接收：

- 简短摘要；
- 结构化事实；
- 验证检查结果；
- 错误代码和有限错误尾部；
- 工件ID、文件名、类型、大小和校验和；
- `truncated`和丢弃数量。

完整日志、生成代码、Notebook、图表和中间文件保存为受控工件，并按runId和TTL管理。

如果是代码打印了大量数据，应提示分析LLM减少打印，改为生成文件或摘要。如果只是输入文件本身很大，不应该要求代码把真实数据强行缩短，而应使用分页、采样和工件引用。

## 12. 与现有AgentLoop的复用边界

可以复用的部分：

- ToolDef和ToolRegistry的工具注册思想；
- ChatOpenAI模型调用配置；
- `model-retry.ts`中的明确错误分类和有限重试原则；
- usage统计、调用ID和结构化诊断日志；
- 取消、超时和最大步骤的控制思想；
- 结构化ToolMessage返回方式。

不应该直接嵌套或复制的部分：

- 主聊天的RAG上下文；
- 图片候选、view_image和图片生成工具；
- 最终回答控制System消息；
- 主聊天SSE流式输出；
- 会话摘要和主历史上下文；
- 主Agent的Prompt Cache前缀；
- 主Agent全部工具目录。

后续如果多个专用任务都需要类似“生成-执行-验证”循环，再抽取一个小型任务harness。当前不要为了一个表格能力提前建设通用多Agent框架。

## 13. 分阶段实施建议

### 阶段0：文件、权限和工件基础

- 扩展上传类型和内容校验；
- 建立会话级workspace；
- 建立attachment、workspace、run和artifact的权限关系；
- 实现输出文件下载和生命周期清理；
- 不引入LLM代码执行。

### 阶段1：确定性表格工具

先实现非LLM的只读工具，例如：

- `inspect_table`：文件元信息、工作表、列名、类型、行数和有限预览；
- `query_table`：固定的筛选、排序、分页、聚合和统计操作。

解析仍应放在受限Worker中，而不是Node主进程。这个阶段可以验证文件授权、工件协议、上下文摘要和前端下载流程，也能覆盖大量常见任务。

### 阶段2：专用Python分析循环

- 增加`analyze_table`高层工具；
- 工具内部使用一个分析LLM；
- 代码在沙箱中执行；
- 使用确定性验证器判断文件和统计结果；
- 失败时把结构化错误交回同一个LLM有限修复；
- 返回摘要和工件引用，不返回完整日志。

### 阶段3：可选独立验证Agent

只在以下场景增加：

- 多文件或多工作表复杂协作；
- 金融、合规、审计等高风险场景；
- 确定性验证通过但业务语义仍不明确；
- 需要并行的独立分析和复核。

## 14. 当前未决定事项

实现前仍需单独确定：

- 初版支持哪些扩展名；
- 每种文件的最大字节数、行数、列数和工作表数；
- 是否允许`.xlsb`、`.xlsm`；
- 沙箱采用受限子进程、独立容器还是更强的microVM；
- 工件保留多久；
- 删除会话时是否立即删除全部输出；
- 分析LLM是否复用主Agent模型和调用配置；
- 内部分析调用如何计入usage；
- 是否允许生成图表、Notebook、PDF等非表格工件；
- 哪些固定查询能力应优先于Python沙箱。

这些事项没有确认前，不应直接开始大范围实现，也不应新增未经讨论的环境变量。

## 15. 一句话记忆

针对当前chat-lite，正确方向是：

> 为每个`conversationId`提供持久工作区；主Agent只调用一个表格分析工具；工具内部使用一个有界的分析LLM循环生成和修复代码；代码只在隔离沙箱运行；确定性验证器决定是否成功；完整日志和文件保存为工件；不要使用“第二个LLM只整理日志”，也不要直接复制完整主AgentLoop。
