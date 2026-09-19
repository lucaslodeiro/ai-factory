import { assertRetrySafe } from "./execution-manager.js";
import type { Store } from "./storage.js";
import type { AgentRole, DeliveryStage, WorkState } from "./types.js";
import { stateName } from "./names.js";

const retryable: WorkState[] = ["FAILED", "CANCELLED", "PAUSED"];

export const retryStageLabel = (state: WorkState) => stateName(state);

export function retry(store: Store, id: string) {
  const w = store.get(id);
  if (!w) throw new Error("Unknown work item");
  if (!retryable.includes(w.state)) throw new Error("Only failed, cancelled or paused items can retry");
  assertRetrySafe(store, id);
  const to = w.context.resume ?? "SPEC";
  if (to === "SPEC" && w.context.waiting === "loop" && !w.context.consultation && w.context.approvedVersion === w.context.version) {
    const stages: Array<[AgentRole,DeliveryStage]> = [["reviewer","REVIEW"],["qa","QA"],["developer","DEVELOPMENT"]];
    const recovered = stages.find(([role]) => {
      const report=w.context.reports[role];
      return report && (report.outcome === "changes" || report.outcome === "decision" || report.findings.some(f => f.classification === "auto-fix" || f.classification === "decision-required"));
    });
    if (recovered) w.context.consultation = { from:recovered[1] };
  }
  delete w.context.lastFailure;
  store.transition(w, to);
  store.event("retry.requested", { to }, id);
  return to;
}
