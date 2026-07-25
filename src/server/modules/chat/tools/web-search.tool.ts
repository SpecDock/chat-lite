import { callMiniMaxTool } from '../../images/mcp.js';

/**
 * Run a single web search via the MCP web_search adapter. Used directly by
 * the `web_search` ToolDef in the new main agent-loop path.
 */
export async function executeWebSearch(input: { query: string }) {
  return await callMiniMaxTool('web_search', { query: input.query });
}
