import 'server-only'

import { requireCapability } from '@/lib/auth/session'
import { requestManualRerun, type RunForExecution } from '@/lib/services/workflow-runs'

/**
 * Session-aware entry point for a Manual Rerun triggered from the UI (Run
 * Detail — Manual Rerun micro-phase).
 *
 * Deliberately thin: every rule that actually matters — same enrollment, a
 * brand new WorkflowRun starting the pipeline from ENRICH, the
 * `workflow_runs_one_active_per_lead_key` conflict, the post-commit
 * `automation/run.requested` emit — already lives in `requestManualRerun`
 * (lib/services/workflow-runs.ts) and is exercised there against the fake DB
 * (tests/unit/automation-engine.test.ts, "24."/"25."). This function's only
 * job is the one thing that module explicitly delegates to its caller:
 * enforce `automation:manage` (ADMIN + MANAGER, docs/product-spec.md §11)
 * against the session before calling it. `requestManualRerun` is deliberately
 * session-free and cannot perform that check itself.
 */
export async function requestManualRerunForCurrentUser(
  sourceRunId: string,
): Promise<RunForExecution> {
  await requireCapability('automation:manage')
  return requestManualRerun(sourceRunId)
}
