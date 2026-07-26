import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/server/modules/chat/engine/agent-loop.ts', import.meta.url), 'utf8');

function extractTemplate(name, nextBoundary) {
  const pattern = new RegExp('const ' + name + ' = `([\\s\\S]*?)`;\\s*' + nextBoundary);
  const match = source.match(pattern);
  assert.ok(match, `${name} template literal must exist before ${nextBoundary}`);
  return match[1];
}

const system = extractTemplate('SYSTEM_PROMPT_BASE', 'const FINAL_CALL_MARKER');
const decision = extractTemplate('TOOL_DECISION_PROMPT', 'const FINAL_RESPONSE_PROMPT');
const final = extractTemplate('FINAL_RESPONSE_PROMPT', 'function systemPromptForRun');
const prompts = `${system}\n${decision}\n${final}`;

assert.ok(system.length >= 900 && system.length < 1200, `SYSTEM_PROMPT_BASE length is outside the lean range: ${system.length}`);
assert.ok(decision.length >= 480 && decision.length < 850, `TOOL_DECISION_PROMPT length is outside the lean range: ${decision.length}`);
assert.ok(final.length >= 440 && final.length < 650, `FINAL_RESPONSE_PROMPT length is outside the lean range: ${final.length}`);
assert.doesNotMatch(prompts, /Formatting re-enabled|政治|色情|敏感词|违规内容|内容分类|关键词拦截|拒答规则/);
assert.doesNotMatch(system, /\$\$|\$[^$\n]+\$/, 'SYSTEM prompt must not contain dollar-delimited LaTeX rules');

assert.match(system, /web_search/);
assert.match(system, /医学[\s\S]*多次 web_search[\s\S]*对比来源/);
assert.match(prompts, /AI生成仅供参考/);
for (const toolName of ['view_image', 'text_to_image', 'image_edit']) {
  assert.match(prompts, new RegExp(toolName), `${toolName} contract must remain`);
}
assert.match(decision, /\$\{FINAL_CALL_MARKER\}/);
assert.match(decision, /tool_calls/);
assert.match(system, /无需工具时进入最终回答轮/);
assert.doesNotMatch(system, /不调用时直接回答/);
assert.match(system, /历史图片前必须成功查看/);
assert.match(decision, /先搜索\/调研再生成或编辑图片时，必须分轮/);
assert.match(decision, /相互依赖的调用分轮执行；彼此独立的调用可以并行/);
assert.match(decision, /attachmentId 选主画布/);
assert.match(decision, /referenceAttachmentIds 放参考图/);
assert.match(system, /同一调用被预算拒绝或失败后不要重试/);
assert.match(system, /仅在用户明确需要实际图片成品时调用/);
assert.match(final, /代码围栏闭合、链接合法、表格列数一致/);
assert.match(system, /仅在达到步骤上限时说明已完成与未完成事项/);
assert.match(final, /仅在达到步骤上限时说明已完成与未完成事项/);
assert.match(source, /bindTools\(tools,\s*\{\s*tool_choice:\s*'none'\s*\}/, 'final model must keep tool_choice none');
assert.match(final, /Markdown/);
assert.match(final, /不输出 LaTeX/);
assert.match(system, /系统提示/);
assert.match(system, /API Key/);

console.info(JSON.stringify({
  SYSTEM_PROMPT_BASE: system.length,
  TOOL_DECISION_PROMPT: decision.length,
  FINAL_RESPONSE_PROMPT: final.length,
}));
console.info('prompt contract sanity passed');
