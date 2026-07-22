export type ToolName = 'web_search' | 'generate_image' | 'image_to_image';

export function intEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function createToolBudget() {
  const limits: Record<ToolName, number> = {
    web_search: Number.POSITIVE_INFINITY,
    generate_image: intEnv('AGENT_MAX_IMAGE_GENERATION_CALLS', 1),
    image_to_image: intEnv('AGENT_MAX_IMAGE_TO_IMAGE_CALLS', 10)
  };
  const counts: Record<ToolName, number> = {
    web_search: 0,
    generate_image: 0,
    image_to_image: 0
  };
  let total = 0;
  const maxTotal = intEnv('AGENT_MAX_TOOL_CALLS', 20);

  return {
    take(name: ToolName) {
      if (total >= maxTotal) return `本轮工具调用次数已达总上限 ${maxTotal} 次，请基于已有信息完成回答。`;
      if (counts[name] >= limits[name]) return `本轮 ${name} 工具调用次数已达上限 ${limits[name]} 次，请不要继续调用该工具。`;
      total += 1;
      counts[name] += 1;
      return undefined;
    }
  };
}

export type ToolBudget = ReturnType<typeof createToolBudget>;
