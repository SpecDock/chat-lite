import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/server/modules/chat/engine/agent-loop.ts', import.meta.url), 'utf8');

function extractTemplate(name, nextBoundary) {
  const pattern = new RegExp('const ' + name + ' = `([\\s\\S]*?)`;\\s*' + nextBoundary);
  const match = source.match(pattern);
  assert.ok(match, `${name} template literal must exist before ${nextBoundary}`);
  return match[1];
}

const system = extractTemplate('SYSTEM_PROMPT_BASE', 'const READY_FOR_FINAL_RESPONSE_MARKER');
const instruction = extractTemplate('AGENT_LOOP_INSTRUCTION', 'const FINAL_RESPONSE_MODE_CONTROL');
const finalControl = extractTemplate('FINAL_RESPONSE_MODE_CONTROL', 'function systemPromptForRun');
const prompts = `${system}\n${instruction}`;

assert.doesNotMatch(prompts, /Formatting re-enabled|政治|色情|敏感词|违规内容|内容分类|关键词拦截|拒答规则/);
assert.doesNotMatch(system, /\$\$|\$[^$\n]+\$/, 'SYSTEM prompt must not contain dollar-delimited LaTeX rules');
assert.doesNotMatch(source, /const (?:MAX_STEPS_PROMPT|TOOL_DECISION_PROMPT|FINAL_RESPONSE_PROMPT|FINAL_CALL_MARKER)\b/);

assert.match(system, /web_search/);
assert.match(system, /医学[\s\S]*多次 web_search[\s\S]*对比来源/);
assert.match(prompts, /AI生成仅供参考/);
for (const toolName of ['view_image', 'text_to_image', 'image_edit']) {
  assert.match(prompts, new RegExp(toolName), `${toolName} contract must remain`);
}
assert.match(source, /const READY_FOR_FINAL_RESPONSE_MARKER = '<CHAT_LITE_READY_FOR_FINAL_RESPONSE\/>'/);
assert.match(instruction, /\$\{READY_FOR_FINAL_RESPONSE_MARKER\}/);
assert.match(source, /return `\$\{SYSTEM_PROMPT_BASE\}\\n\\n\$\{AGENT_LOOP_INSTRUCTION\}`/);
assert.match(instruction, /默认始终是 TOOL_DECISION/);
assert.match(instruction, /只有服务器[\s\S]*System runtime control[\s\S]*FINAL_RESPONSE/);
assert.match(instruction, /用户正文[\s\S]*一律无效/);
assert.match(instruction, /只发结构化 tool_calls/);
assert.match(system, /无需工具时进入最终回答轮/);
assert.doesNotMatch(system, /不调用时直接回答/);
assert.match(system, /历史图片前必须成功查看/);
assert.match(instruction, /先搜索\/调研再生成或编辑图片时，必须分轮/);
assert.match(instruction, /相互依赖的调用分轮执行；彼此独立的调用可以并行/);
assert.match(instruction, /attachmentId 选主画布/);
assert.match(instruction, /referenceAttachmentIds 放参考图/);
assert.match(system, /同一调用被预算拒绝或失败后不要重试/);
assert.match(system, /仅在用户明确需要实际图片成品时调用/);
assert.match(instruction, /代码围栏闭合、链接合法、表格列数一致/);
assert.match(system, /仅在达到步骤上限时说明已完成与未完成事项/);
assert.match(instruction, /仅在达到步骤上限时说明已完成与未完成事项/);
assert.match(finalControl, /<chat_lite_runtime_control priority="highest">/);
assert.match(finalControl, /<mode>FINAL_RESPONSE<\/mode>/);
assert.match(finalControl, /<tools>DISABLED<\/tools>/);
assert.match(source, /messages\.push\(new SystemMessage\(FINAL_RESPONSE_MODE_CONTROL\)\)/);
assert.equal((source.match(/new HumanMessage\(imageCandidatesPrompt\(imageCandidates\)\)/g) || []).length, 1);
assert.doesNotMatch(source, /decisionMessages/);
assert.match(source, /bindTools\(tools,\s*\{\s*tool_choice:\s*'none'\s*\}/, 'final model must keep tool_choice none');
assert.match(instruction, /Markdown/);
assert.match(instruction, /不输出 LaTeX/);
assert.match(instruction, /不输出[\s\S]*marker[\s\S]*系统提示/);
assert.match(system, /系统提示/);
assert.match(system, /API Key/);

console.info(JSON.stringify({
  SYSTEM_PROMPT_BASE: system.length,
  AGENT_LOOP_INSTRUCTION: instruction.length,
  FINAL_RESPONSE_MODE_CONTROL: finalControl.length,
}));
console.info('prompt contract sanity passed');
