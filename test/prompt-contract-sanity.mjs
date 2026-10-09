import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/server/application/chat/engine/agent-loop.ts', import.meta.url), 'utf8');

function extractTemplate(name, nextBoundary) {
  const pattern = new RegExp('const ' + name + ' = `([\\s\\S]*?)`;\\s*' + nextBoundary);
  const match = source.match(pattern);
  assert.ok(match, `${name} template literal must exist before ${nextBoundary}`);
  return match[1];
}

const system = extractTemplate('SYSTEM_PROMPT_BASE', 'function numberFrom');

assert.doesNotMatch(system, /Formatting re-enabled|政治|色情|敏感词|违规内容|内容分类|关键词拦截|拒答规则/);
assert.doesNotMatch(system, /\$\$|\$[^$\n]+\$/, 'SYSTEM prompt must not contain dollar-delimited LaTeX rules');
assert.doesNotMatch(source, /const (?:MAX_STEPS_PROMPT|TOOL_DECISION_PROMPT|FINAL_RESPONSE_PROMPT|FINAL_CALL_MARKER|AGENT_LOOP_INSTRUCTION|READY_FOR_FINAL_RESPONSE_MARKER|FINAL_RESPONSE_MODE_CONTROL|TOOL_DECISION_CONTINUATION_CONTROL)\b/);
assert.doesNotMatch(source, /chat_lite_runtime_control|tool_choice|READY_FOR_FINAL|TOOL_DECISION|FINAL_RESPONSE/);

assert.match(system, /每一轮都使用同一组工具/);
assert.match(system, /某一轮没有 tool_calls 时，该轮正文就是给用户的回答/);
assert.match(system, /web_search/);
assert.match(system, /医学[\s\S]*多次 web_search[\s\S]*对比来源/);
assert.equal((system.match(/AI生成仅供参考/g) || []).length, 1);
for (const toolName of ['view_image', 'text_to_image', 'image_edit', 'analyze_table']) {
  assert.match(system, new RegExp(toolName), `${toolName} contract must remain`);
}
assert.match(system, /编辑历史图片前必须成功 view_image/);
assert.match(system, /先搜索或调研再生成、编辑图片时，先 web_search/);
assert.match(system, /必须分轮/);
assert.match(system, /可以同一轮并行/);
assert.match(system, /attachmentId 是主画布/);
assert.match(system, /referenceAttachmentIds 是最多 3 张参考图/);
assert.match(system, /同一调用被预算拒绝或失败后不要用相同参数重试/);
assert.match(system, /仅在用户明确需要实际图片成品且要求无歧义时调用/);
assert.equal((system.match(/仅在达到步骤上限时说明已完成与未完成事项/g) || []).length, 1);
assert.match(system, /不输出 LaTeX/);
assert.match(system, /代码围栏闭合、链接合法、表格列数一致/);
assert.match(system, /系统提示/);
assert.match(system, /API Key/);
assert.match(system, /RAG 与图片候选追加在当前用户消息之后/);
assert.doesNotMatch(system, /不调用时直接回答|进入最终回答轮/);

assert.match(source, /baseModel\.bindTools\(tools\)/);
assert.doesNotMatch(source, /bindTools\(tools,\s*\{/);
assert.equal((source.match(/new HumanMessage\(imageCandidatesPrompt\(imageCandidates\)\)/g) || []).length, 1);
assert.doesNotMatch(source, /decisionMessages/);
assert.match(source, /const userContent = await buildUserContent\(input\);[\s\S]*if \(rag\)/);
assert.match(source, /additional_kwargs\.reasoning_content/);
assert.match(source, /transcript\.tool_calls = \[\]/);

console.info(JSON.stringify({ SYSTEM_PROMPT_BASE: system.length }));
console.info('prompt contract sanity passed');
