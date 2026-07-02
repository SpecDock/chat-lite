import type { TaskRoute } from '../task-router.js';
import type { WorkflowInput } from '../workflows/types.js';
import type { Plan, PlanStep } from './plan.types.js';
import { assertPlanShape } from './plan.types.js';

function step(id: string, type: PlanStep['type'], args?: Record<string, unknown>, optional = false): PlanStep {
  return { id, type, args, optional, onError: optional ? 'continue' : 'fail' };
}

function wantsDescription(input: string) {
  return /先.*(说|描述|识别|分析)|这是什么|图片.*什么|先看/.test(input);
}

export function buildPlanFromRoute(route: TaskRoute, input: WorkflowInput): Plan {
  let steps: PlanStep[];
  switch (route.intent) {
    case 'web_search':
      steps = [step('search', 'web_search', { query: input.input }), step('answer', 'llm_respond')];
      break;
    case 'vision_qa':
      steps = [step('vision', 'vision_understand', { attachmentId: route.sourceAttachmentId || input.sourceAttachmentId, prompt: input.input }), step('answer', 'llm_respond', { mode: 'vision' })];
      break;
    case 'text_to_image': {
      const prompts = (route.prompts || input.prompts || []).filter(p => String(p || '').trim().length > 0);
      const batch = prompts.length > 1;
      steps = batch
        ? [step('refine_batch', 'prompt_refine_text_batch', { count: prompts.length }), step('generate_batch', 'text_to_image', { batch: true }), step('literal', 'literal_response')]
        : [step('refine', 'prompt_refine_text'), step('generate', 'text_to_image', { batch: false }), step('literal', 'literal_response')];
      break;
    }
    case 'image_edit':
      const needsDescription = wantsDescription(input.input) || route.needVision;
      steps = [];
      if (needsDescription) steps.push(step('vision', 'vision_understand', { attachmentId: route.sourceAttachmentId || input.sourceAttachmentId, prompt: input.input }));
      steps.push(step('refine_edit', 'prompt_refine_edit'), step('edit', 'image_edit', { attachmentId: route.sourceAttachmentId || input.sourceAttachmentId }), step('literal', 'literal_response'));
      if (needsDescription) steps[steps.length - 1] = step('answer', 'llm_respond', { mode: 'image_edit' });
      break;
    case 'mixed':
      steps = [step('agent', 'agent_fallback')];
      break;
    case 'chat':
    default:
      steps = [step('answer', 'llm_respond')];
      break;
  }
  const plan = { id: `plan_${route.intent}`, intent: route.intent, steps };
  assertPlanShape(plan);
  return plan;
}
