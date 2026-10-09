type TavilyResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
};

function tavilyApiKey() {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) throw new Error('web_search 未配置：请设置 TAVILY_API_KEY');
  return key;
}

function formatTavilyResult(result: TavilyResult) {
  const title = typeof result.title === 'string' ? result.title : '无标题';
  const url = typeof result.url === 'string' ? result.url : '';
  const content = typeof result.content === 'string' ? result.content : '';
  const score = typeof result.score === 'number' ? `相关度=${result.score.toFixed(3)}` : '';
  return `### ${title}\n${url}\n${score}\n${content}`.trim();
}

export async function executeWebSearch(input: { query: string; signal?: AbortSignal }) {
  const query = input.query.trim();
  if (!query) throw new Error('web_search 查询不能为空');

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tavilyApiKey()}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      query,
      topic: 'general',
      search_depth: 'basic',
      max_results: 5,
      include_answer: false,
      include_raw_content: false
    }),
    signal: input.signal
  });

  const responseText = await response.text();
  let data: { results?: TavilyResult[]; detail?: unknown; message?: unknown } = {};
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(`Tavily web_search 返回非 JSON 响应 HTTP ${response.status}`);
  }
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : typeof data.message === 'string' ? data.message : '';
    throw new Error(`Tavily web_search 失败 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
  }

  const results = Array.isArray(data.results) ? data.results : [];
  return [
    `Tavily 搜索结果：${query}`,
    results.length ? results.map(formatTavilyResult).join('\n\n') : '（没有返回搜索结果）'
  ].join('\n\n');
}
