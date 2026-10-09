export type ModelContextRole = 'system' | 'human' | 'ai' | 'tool';

export type ModelContextToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ModelContextTextBlock = {
  type: 'text';
  text: string;
};

export type ModelContextImageBlock = {
  type: 'image_url';
  image_url: { url: string };
};

export type ModelContextContentBlock = ModelContextTextBlock | ModelContextImageBlock;

export type ModelContextMessage = {
  role: ModelContextRole;
  content: string | ModelContextContentBlock[];
  tool_calls?: ModelContextToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isRole(value: unknown): value is ModelContextRole {
  return value === 'system' || value === 'human' || value === 'ai' || value === 'tool';
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function canonicalizeContentBlock(part: unknown, messageIndex: number, partIndex: number): ModelContextContentBlock {
  if (!isRecord(part)) {
    throw new Error(`model context message ${messageIndex} content[${partIndex}] must be an object`);
  }
  if (part.type === 'text') {
    if (typeof part.text !== 'string') {
      throw new Error(`model context message ${messageIndex} content[${partIndex}].text must be a string`);
    }
    return { type: 'text', text: part.text };
  }
  if (part.type === 'image_url') {
    if (!isRecord(part.image_url)) {
      throw new Error(`model context message ${messageIndex} content[${partIndex}].image_url must be an object`);
    }
    return {
      type: 'image_url',
      image_url: {
        url: requiredString(part.image_url.url, `model context message ${messageIndex} content[${partIndex}].image_url.url`),
      },
    };
  }
  throw new Error(`model context message ${messageIndex} content[${partIndex}] has an invalid type`);
}

function canonicalizeContent(value: unknown, index: number, role: ModelContextRole): string | ModelContextContentBlock[] {
  if (typeof value === 'string') return value;
  if (role !== 'human' || !Array.isArray(value) || value.length === 0) {
    throw new Error(`model context message ${index} content must be a string`);
  }
  return value.map((part, partIndex) => canonicalizeContentBlock(part, index, partIndex));
}

function canonicalizeToolCall(call: unknown, messageIndex: number, callIndex: number): ModelContextToolCall {
  if (!isRecord(call)) {
    throw new Error(`model context message ${messageIndex} tool_calls[${callIndex}] must be an object`);
  }
  if (typeof call.arguments !== 'string') {
    throw new Error(`model context message ${messageIndex} tool_calls[${callIndex}].arguments must be a string`);
  }
  return {
    id: requiredString(call.id, `model context message ${messageIndex} tool_calls[${callIndex}].id`),
    name: requiredString(call.name, `model context message ${messageIndex} tool_calls[${callIndex}].name`),
    arguments: call.arguments,
  };
}

function canonicalizeMessage(message: unknown, index: number): ModelContextMessage {
  if (!isRecord(message)) throw new Error(`model context message ${index} must be an object`);
  if (!isRole(message.role)) throw new Error(`model context message ${index} has an invalid role`);
  const content = canonicalizeContent(message.content, index, message.role);
  if (message.role === 'tool') {
    if (message.tool_calls !== undefined) {
      throw new Error(`model context message ${index} cannot include tool_calls`);
    }
    if (message.reasoning_content !== undefined) {
      throw new Error(`model context message ${index} cannot include reasoning_content`);
    }
    return {
      role: message.role,
      content,
      tool_call_id: requiredString(message.tool_call_id, `model context message ${index} tool_call_id`),
    };
  }
  if (message.tool_call_id !== undefined) {
    throw new Error(`model context message ${index} cannot include tool_call_id`);
  }
  if (message.role === 'system' || message.role === 'human') {
    if (message.tool_calls !== undefined) {
      throw new Error(`model context message ${index} cannot include tool_calls`);
    }
    if (message.reasoning_content !== undefined) {
      throw new Error(`model context message ${index} cannot include reasoning_content`);
    }
    return { role: message.role, content };
  }
  const canonical: ModelContextMessage = { role: 'ai', content };
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) {
      throw new Error(`model context message ${index} tool_calls must be an array`);
    }
    canonical.tool_calls = message.tool_calls.map((call, callIndex) => canonicalizeToolCall(call, index, callIndex));
  }
  if (message.reasoning_content !== undefined) {
    if (typeof message.reasoning_content !== 'string') {
      throw new Error(`model context message ${index} reasoning_content must be a string`);
    }
    canonical.reasoning_content = message.reasoning_content;
  }
  return canonical;
}

export function serializeModelContext(messages: readonly ModelContextMessage[]) {
  if (!Array.isArray(messages)) throw new Error('model context must be an array');
  return JSON.stringify(messages.map((message, index) => canonicalizeMessage(message, index)));
}

export function parseModelContext(json: string) {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('model context JSON is invalid');
  }
  if (!Array.isArray(value)) throw new Error('model context must be an array');
  return value.map((message, index) => canonicalizeMessage(message, index));
}
