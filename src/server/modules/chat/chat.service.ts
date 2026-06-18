export function defaultUserInput(content: string, attachmentCount: number) {
  return content || '';
}

export function userMessageContent(input: string, attachmentIds: string[]) {
  if (!attachmentIds.length) return input;
  return `${input}\n\n${attachmentIds.map(id => `![image](/api/files/${id})`).join('\n')}`;
}

export function agentInputForMessage(input: string, attachmentIds: string[]) {
  if (!attachmentIds.length) return input;
  return `${input}\n\n本轮图片附件 ID：${attachmentIds.join(', ')}。如果用户需要识别/分析图片，请调用 understand_image；如果用户需要基于原图生成或修改图片，请调用 image_to_image。`;
}

export function requiresGeneratedImage(input: string, attachmentIds: string[]) {
  if (!attachmentIds.length) return false;
  return /(添加|加上|放上|贴纸|爱心|修改|编辑|改图|改成|换|去掉|删除|擦除|重绘|生成|动漫化|风格|背景|头像|海报|插画|图生图|参考原图|根据.*图)/.test(input)
    && !/(不要生成|不用生成|不要改|只识别|只分析|只描述)/.test(input);
}

export function hasGeneratedImageLink(output: string) {
  return /!\[[^\]]*\]\(\/api\/files\/att_[^)]+\)/.test(output);
}

export function looksLikeUnfinishedPlan(output: string) {
  const text = output.trim();
  return /(我先|我会|然后|接下来|准备|将会|再帮你|再按|稍后|正在|我去|我帮你).*?(看图|确认|识别|调用|生成|编辑|处理|加|添加|搜索|搜|查|联网|找)/.test(text)
    && !hasGeneratedImageLink(text)
    && !/(无法|不能|失败|暂不可用|配置|报错)/.test(text);
}

export function shouldForceSearchFallback(input: string, output: string) {
  if (/(翻译|润色|改写|写代码|代码|函数|组件|SQL|正则|作文|邮件|文案)/i.test(input)) return false;
  return /(搜索|联网|最新|今天|新闻|网页|网址|价格|政策|实时|搜一下|查一下|帮我搜|帮我查|找一下|了解一下|百度|谷歌|最近怎么样|search|look up|find out|google it)/i.test(input)
    || /(我去搜索|我先查|我帮你查|我帮你搜|我来搜索|我来查|需要搜索|需要联网)/.test(output);
}

export function parseChatRequest(body: unknown) {
  const source = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const content = String(source.content || source.message || '').trim();
  const conversationId = String(source.conversationId || '').trim();
  const attachmentIds = Array.isArray(source.attachmentIds) ? source.attachmentIds.map(String).filter(Boolean).slice(0, 4) : [];
  return { content, conversationId, attachmentIds, userInput: defaultUserInput(content, attachmentIds.length) };
}
