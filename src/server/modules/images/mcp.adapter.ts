import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let mcpClientPromise: Promise<Client> | null = null;

function requireMiniMaxKey() {
  const apiKey = process.env.MINIMAX_API_KEY || process.env.MINIMAX_MCP_API_KEY;
  if (!apiKey) throw new Error('MiniMax MCP 未配置：请设置 MINIMAX_API_KEY');
  return apiKey;
}

function parseArgs(value: string | undefined) {
  return (value || 'minimax-coding-plan-mcp -y').split(' ').map(x => x.trim()).filter(Boolean);
}

function cleanEnv(env: NodeJS.ProcessEnv, extra: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return { ...out, ...extra };
}

export async function getMiniMaxMcpClient() {
  if (mcpClientPromise) return mcpClientPromise;
  mcpClientPromise = (async () => {
    const apiKey = requireMiniMaxKey();
    const client = new Client({ name: 'chat-lite', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: process.env.MINIMAX_MCP_COMMAND || 'uvx',
      args: parseArgs(process.env.MINIMAX_MCP_ARGS),
      env: cleanEnv(process.env, {
        MINIMAX_API_KEY: apiKey,
        MINIMAX_API_HOST: process.env.MINIMAX_API_HOST || 'https://api.minimaxi.com',
        MINIMAX_MCP_BASE_PATH: process.env.MINIMAX_MCP_BASE_PATH || process.env.UPLOAD_DIR || process.env.DATA_DIR || './data'
      })
    });
    await client.connect(transport);
    return client;
  })().catch((error) => {
    mcpClientPromise = null;
    throw error;
  });
  return mcpClientPromise;
}

function mcpContentToText(content: unknown) {
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content.map((item: any) => {
    if (item?.type === 'text') return item.text;
    if (item?.type === 'image') return `[image:${item.mimeType || 'unknown'}]`;
    return JSON.stringify(item);
  }).join('\n');
}

export async function callMiniMaxTool(name: 'web_search' | 'understand_image', args: Record<string, unknown>) {
  const client = await getMiniMaxMcpClient();
  const result = await client.callTool({ name, arguments: args });
  return mcpContentToText((result as any).content);
}

export async function webSearchWithMiniMax(query: string) {
  return callMiniMaxTool('web_search', { query });
}

export async function understandImageWithMiniMax(imagePathOrUrl: string, prompt: string) {
  return callMiniMaxTool('understand_image', { image_source: imagePathOrUrl, prompt });
}
