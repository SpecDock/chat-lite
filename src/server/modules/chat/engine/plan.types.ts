import type { ToolName } from './tool-def.js';

export const MAX_PLAN_STEPS = 6;

export type StepFailurePolicy = 'fail' | 'continue';

export type PlanStep = {
  id: string;
  type: ToolName;
  args?: Record<string, unknown>;
  optional?: boolean;
  onError?: StepFailurePolicy;
};

export type Plan = {
  id: string;
  intent: string;
  steps: PlanStep[];
};

export const PLAN_TOOL_WHITELIST = [
  'web_search',
  'vision_understand',
  'llm_respond',
  'prompt_refine_text',
  'prompt_refine_text_batch',
  'prompt_refine_edit',
  'text_to_image',
  'image_edit',
  'literal_response',
  'agent_fallback'
] as const satisfies readonly ToolName[];

export function assertPlanShape(plan: Plan) {
  if (plan.steps.length > MAX_PLAN_STEPS) throw new Error(`执行计划超过最大步数 ${MAX_PLAN_STEPS}`);
  for (const step of plan.steps) {
    if (!PLAN_TOOL_WHITELIST.includes(step.type)) throw new Error(`执行计划包含不允许的步骤：${step.type}`);
  }
}
