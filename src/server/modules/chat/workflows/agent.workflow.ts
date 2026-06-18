import { streamAgentChat } from '../agent.js';
import type { WorkflowEvent, WorkflowInput } from './types.js';

export function runAgentWorkflow(input: WorkflowInput): AsyncGenerator<WorkflowEvent> {
  return streamAgentChat(input);
}
