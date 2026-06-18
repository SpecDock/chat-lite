import type { TaskRoute } from '../task-router.js';
import type { WorkflowEvent, WorkflowInput } from './types.js';
import { runAgentWorkflow } from './agent.workflow.js';
import { runChatWorkflow } from './chat.workflow.js';
import { runImageEditWorkflow } from './image-edit.workflow.js';
import { runSearchWorkflow } from './search.workflow.js';
import { runTextImageWorkflow } from './text-image.workflow.js';
import { runVisionWorkflow } from './vision.workflow.js';

export function runWorkflow(route: TaskRoute, input: WorkflowInput): AsyncGenerator<WorkflowEvent> {
  if (route.intent === 'chat') return runChatWorkflow(input);
  if (route.intent === 'vision_qa') return runVisionWorkflow(input);
  if (route.intent === 'image_edit') return runImageEditWorkflow(input);
  if (route.intent === 'text_to_image') return runTextImageWorkflow(input);
  if (route.intent === 'web_search') return runSearchWorkflow(input);
  return runAgentWorkflow(input);
}
