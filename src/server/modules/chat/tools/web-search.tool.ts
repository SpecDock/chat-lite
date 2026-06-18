import { tool } from 'langchain';
import { z } from 'zod';
import { callMiniMaxTool } from '../../images/mcp.js';
import type { ToolBudget } from './tool-budget.js';

export async function executeWebSearch(input: { query: string }) {
  return await callMiniMaxTool('web_search', { query: input.query });
}

export function createWebSearchTool(input: { budget: ToolBudget }) {
  const { budget } = input;
  return tool(async ({ query }) => {
    const blocked = budget.take('web_search');
    if (blocked) return blocked;
    try {
      return await executeWebSearch({ query });
    } catch (error) {
      return `web_search 工具暂不可用：${error instanceof Error ? error.message : '未知错误'}`;
    }
  }, {
    name: 'web_search',
    description: '联网搜索工具。用于查询实时信息、新闻、网页内容或用户明确要求搜索时。输入自然语言搜索词。',
    schema: z.object({ query: z.string().min(1).describe('搜索查询词') })
  });
}