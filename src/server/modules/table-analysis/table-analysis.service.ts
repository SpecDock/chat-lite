import { copyFile, chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { row } from '../../core/db.js';
import { dataDir } from '../../core/db.js';
import { isWithinDirectory, conversationWorkspaceDir } from '../../core/workspace-paths.js';
import { newId } from '../../core/security.js';
import { isWorkspaceAttachment } from '../workspace/workspace.service.js';
import { createChatModel } from '../chat/model.js';
import { aggregateAgentUsage, type AgentContext, type AgentEvent, type AgentUsage } from '../chat/engine/tool-def.js';
import { runTableSandbox, TABLE_SANDBOX_JOBS, type SandboxResult } from './sandbox-client.js';

const MAX_ATTEMPTS = 3;
const MAX_CODE_BYTES = 1 * 1024 * 1024;
const ACTION_SCHEMA = z.object({ code: z.string().min(1).max(MAX_CODE_BYTES) }).strict();

type TableAttachment = {
  id: string;
  original_name: string;
  file_path: string;
  mime_type: string;
  size: number;
};

function isTableAttachment(attachment: TableAttachment) {
  const extension = extname(attachment.original_name).toLowerCase();
  return (extension === '.csv' || extension === '.xlsx') && attachment.mime_type !== 'image/jpeg' && attachment.mime_type !== 'image/png' && attachment.mime_type !== 'image/webp';
}

function safeName(value: string) {
  const name = basename(String(value || '').replace(/[\\/]/g, '/')).replace(/[\0\r\n]/g, '').trim();
  return name.slice(0, 180) || 'table.csv';
}

function attachmentFor(ctx: AgentContext, attachmentId: string) {
  const attachment = row<TableAttachment>(
    `SELECT id, original_name, file_path, mime_type, size
       FROM attachments WHERE id=? AND user_id=? AND conversation_id=?`,
    attachmentId, ctx.userId, ctx.conversationId,
  );
  if (!attachment || !isTableAttachment(attachment) || !isWorkspaceAttachment(attachment.file_path, ctx.conversationId, 'input')) {
    throw new Error('表格附件不存在、类型不支持或不属于当前会话');
  }
  return attachment;
}

function structuredPrompt(metadata: TableAttachment, instruction: string, virtualName: string) {
  return `任务：${instruction}\n\n输入文件元数据：\n- 文件名：${metadata.original_name}\n- MIME：${metadata.mime_type}\n- 字节数：${metadata.size}\n- 虚拟路径：input/${virtualName}\n\n只生成一个 Python 脚本。脚本必须从 input/${virtualName} 读取文件，不能访问网络、环境变量、绝对路径或其它文件；将面向用户的简洁结果打印到 stdout。不要解释代码，不要输出 Markdown，必须通过 write_python 结构化输出。`;
}

function usageNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function usageFromModelResponse(value: unknown): AgentUsage | undefined {
  const response = value as any;
  const usage = response?.usage_metadata || response?.usageMetadata
    || response?.response_metadata?.tokenUsage || response?.response_metadata?.usage
    || response?.llmOutput?.tokenUsage || response?.tokenUsage;
  if (!usage) return undefined;
  const promptTokens = usageNumber(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens);
  const completionTokens = usageNumber(usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens);
  const totalTokens = usageNumber(usage.total_tokens ?? usage.totalTokens)
    ?? ((promptTokens !== undefined || completionTokens !== undefined)
      ? (promptTokens || 0) + (completionTokens || 0)
      : undefined);
  const cachedTokens = usageNumber(
    usage.input_token_details?.cache_read
      ?? usage.input_token_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.cached_tokens,
  ) ?? 0;
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return {
    model: response?.response_metadata?.model_name || response?.response_metadata?.model || undefined,
    promptTokens,
    completionTokens,
    totalTokens,
    ...(promptTokens !== undefined ? { cacheMeasuredPromptTokens: promptTokens, cachedTokens } : {}),
  };
}

function resultText(result: SandboxResult) {
  const parts = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  return parts.join('\n\n') || '（无输出）';
}

function validateTableOutput(result: SandboxResult, instruction: string) {
  if (result.status !== 'succeeded' || result.exit_code !== 0) return `Python 执行状态为 ${result.status}，退出码为 ${result.exit_code ?? '空'}。`;
  const output = result.stdout || '';
  const wantsInput = /输入|提示词|prompt|input.*token/i.test(instruction);
  const wantsOutput = /输出|补全|completion|output.*token/i.test(instruction);
  const wantsCache = /缓存|cache/i.test(instruction);
  if (wantsInput && (/输入\s*=\s*未识别/.test(output) || /输入\s*token\s*总量[^\n]*无法计算/i.test(output))) {
    return '输入 token 字段仍未识别或无法计算；必须重新检查实际中文列名。';
  }
  if (wantsOutput && (/输出\s*=\s*未识别/.test(output) || /输出\s*token\s*总量[^\n]*无法计算/i.test(output))) {
    return '输出 token 字段仍未识别或无法计算；必须重新检查实际中文列名。';
  }
  if (wantsCache && /详情/.test(output) && (/缓存命中量\s*=\s*未识别/.test(output) || /缓存命中总量[^\n]*无法计算/i.test(output))) {
    return '详情列中可能包含缓存字段，但缓存命中量仍未识别；必须解析详情中的 JSON 或键值文本后再计算。';
  }
  return undefined;
}

function structuredResult(result: SandboxResult, validationError?: string) {
  return JSON.stringify({
    status: result.status,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    duration_ms: result.duration_ms,
    timed_out: result.timed_out,
    validation: {
      passed: result.status === 'succeeded' && result.exit_code === 0 && !validationError,
      error: validationError,
    },
  }, null, 2);
}

async function requestPythonCode(
  model: ReturnType<typeof createChatModel>,
  messages: BaseMessage[],
  signal: AbortSignal | undefined,
  onUsage: (usage: AgentUsage) => void,
) {
  const structured = model.withStructuredOutput(ACTION_SCHEMA, { name: 'write_python', strict: true, includeRaw: true });
  const invoke = async () => {
    const response = await structured.invoke(messages, signal ? { signal } : undefined) as { raw?: unknown; parsed?: unknown };
    const usage = usageFromModelResponse(response?.raw);
    if (usage) onUsage(usage);
    const parsed = response?.parsed;
    return ACTION_SCHEMA.parse(parsed);
  };
  try {
    return await invoke();
  } catch (firstError) {
    messages.push(new HumanMessage(`上一次结构化代码输出失败（${firstError instanceof Error ? firstError.name : 'unknown'}）。立即补救：只调用 write_python，参数只包含一个合法的 code 字符串，不要输出其它内容。`));
    return await invoke();
  }
}

async function prepareRun(ctx: AgentContext, attachment: TableAttachment) {
  if (process.platform !== 'linux') throw new Error('表格沙箱只在 Linux Docker 运行环境中可用');
  const runId = newId('run');
  const jobId = newId('job');
  const workspaceRoot = conversationWorkspaceDir(dataDir, ctx.conversationId);
  const runRoot = resolve(join(workspaceRoot, 'workspace', runId));
  const jobRoot = resolve(join(TABLE_SANDBOX_JOBS, jobId));
  if (!isWithinDirectory(workspaceRoot, runRoot) || !isWithinDirectory(TABLE_SANDBOX_JOBS, jobRoot)) throw new Error('表格临时目录校验失败');
  const virtualName = safeName(attachment.original_name);
  const inputPath = join(runRoot, 'input', virtualName);
  const jobInputPath = join(jobRoot, 'input', virtualName);
  await mkdir(join(runRoot, 'input'), { recursive: true, mode: 0o755 });
  await mkdir(join(jobRoot, 'input'), { recursive: true, mode: 0o755 });
  await chmod(runRoot, 0o777);
  await chmod(jobRoot, 0o1777);
  await copyFile(attachment.file_path, inputPath);
  await copyFile(attachment.file_path, jobInputPath);
  await chmod(inputPath, 0o444);
  await chmod(jobInputPath, 0o444);
  await chmod(join(runRoot, 'input'), 0o555);
  await chmod(join(jobRoot, 'input'), 0o555);
  await writeFile(join(runRoot, 'metadata.json'), JSON.stringify({ attachmentId: attachment.id, originalName: attachment.original_name, mimeType: attachment.mime_type, size: attachment.size, virtualName }, null, 2), 'utf8');
  return { runId, jobId, runRoot, jobRoot, virtualName };
}

async function cleanupRun(runRoot: string, jobRoot: string) {
  await Promise.allSettled([
    rm(runRoot, { recursive: true, force: true }),
    rm(jobRoot, { recursive: true, force: true }),
  ]);
}

export async function* executeTableAnalysis(args: { attachmentId: string; instruction: string }, ctx: AgentContext): AsyncGenerator<AgentEvent | string> {
  const attachment = attachmentFor(ctx, args.attachmentId);
  const run = await prepareRun(ctx, attachment);
  let cleanupDeferred = false;
  const cleanup = async () => cleanupRun(run.runRoot, run.jobRoot);
  try {
    const model = createChatModel();
    const messages: BaseMessage[] = [
      new SystemMessage('你是专用 CSV/XLSX 分析程序员。每次只通过 write_python 结构化生成 Python 代码。上下文是一个小任务，必须完整保留，不得总结或裁剪之前的代码和执行结果。先读取并打印实际列名，再按实际列名计算，不能只匹配英文列名。常见中文列名映射包括：提示词tokens/提示词 token/输入tokens/输入 token 对应输入 token，补全tokens/补全 token/输出tokens/输出 token 对应输出 token。若缓存字段不在表头，必须解析详情列中的 JSON 或键值文本，识别 cached_tokens、cache_read_input_tokens、cache_read_tokens、缓存命中量、缓存命中token数等字段；不能因为列名不是英文就报告未识别。'),
      new HumanMessage(structuredPrompt(attachment, args.instruction, run.virtualName)),
    ];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let action: Awaited<ReturnType<typeof requestPythonCode>> | undefined;
      let attemptUsage: AgentUsage | undefined;
      try {
        action = await requestPythonCode(model, messages, ctx.signal, usage => {
          attemptUsage = aggregateAgentUsage(attemptUsage, usage);
        });
      } finally {
        if (attemptUsage) yield { type: 'usage', usage: attemptUsage };
      }
      if (!action) throw new Error('表格分析模型未返回结构化代码');
      const code = action.code;
      await writeFile(join(run.runRoot, `attempt-${attempt}.py`), code, 'utf8');
      const result = await runTableSandbox(run.jobId, code, ctx.signal);
      const validationError = validateTableOutput(result, args.instruction);
      messages.push(new AIMessage(JSON.stringify({ tool: 'write_python', code })));
      messages.push(new ToolMessage({ tool_call_id: `table-run-${attempt}`, content: structuredResult(result, validationError) }));
      if (result.status === 'succeeded' && result.exit_code === 0 && !validationError) {
        if (ctx.deferCleanup) {
          ctx.deferCleanup(cleanup);
          cleanupDeferred = true;
        }
        const output = resultText(result);
        yield { type: 'execution', language: 'python', code, output };
        yield `表格分析已成功执行。文件：${attachment.original_name}。执行输出：\n${output}`;
        return;
      }
      if (attempt < MAX_ATTEMPTS) {
        messages.push(new HumanMessage(`第 ${attempt} 次执行未通过确定性校验：${validationError || `进程状态为 ${result.status}，退出码为 ${result.exit_code ?? '空'}`}。请完整查看上一轮代码和结构化执行结果，修复后再次通过 write_python 输出完整 Python 代码。`));
        yield { type: 'think', text: `表格代码第 ${attempt} 次未通过，正在让分析程序修复。` };
      }
    }
    throw new Error(`表格代码连续 ${MAX_ATTEMPTS} 次未通过执行校验`);
  } finally {
    if (!cleanupDeferred) await cleanup();
  }
}
