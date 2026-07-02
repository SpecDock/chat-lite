import type { TaskRoute } from '../task-router.js';
import type { WorkflowEvent, WorkflowInput } from '../workflows/types.js';
import { ArtifactStore } from './artifact-store.js';
import type { Plan } from './plan.types.js';
import { assertPlanShape } from './plan.types.js';
import { createDefaultToolRegistry, type ToolRegistry } from './tool-registry.js';
import type { ToolContext } from './tool-def.js';
import { assertNotAborted } from './tool-def.js';

export async function* executePlan(plan: Plan, route: TaskRoute, input: WorkflowInput, registry: ToolRegistry = createDefaultToolRegistry()): AsyncGenerator<WorkflowEvent> {
  assertPlanShape(plan);
  const ctx: ToolContext = { ...input, route, artifacts: new ArtifactStore() };
  for (const planStep of plan.steps) {
    assertNotAborted(input.signal);
    yield { type: 'think', text: `执行步骤：${planStep.type}` };
    let failed = false;
    for await (const result of registry.execute(planStep.type, planStep.args || {}, ctx)) {
      assertNotAborted(input.signal);
      if (result.type === 'think' || result.type === 'delta' || result.type === 'usage') {
        yield result;
        continue;
      }
      if (result.think) yield { type: 'think', text: result.think };
      if (result.status === 'success') {
        if (result.artifacts) {
          for (const [key, value] of Object.entries(result.artifacts)) ctx.artifacts.set(key, value);
        }
      } else {
        failed = true;
        yield { type: 'think', text: `${planStep.type} 失败：${result.error}` };
        if (planStep.optional) {
          break;
        }
        if (result.recoverable) {
          yield { type: 'delta', text: result.error };
          return;
        }
        if (!planStep.optional && planStep.onError !== 'continue' && !result.recoverable) throw new Error(result.error);
      }
    }
    if (failed && planStep.optional) continue;
  }
}
