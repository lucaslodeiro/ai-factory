import { assertRetrySafe } from "./execution-manager.js";
import type { Store } from "./storage.js";
import type { WorkState } from "./types.js";

const retryable: WorkState[] = ["FAILED", "CANCELLED", "PAUSED"];

const stageLabels: Partial<Record<WorkState,string>> = {
  SPEC: "Product Architect",
  WAITING_HUMAN: "human input",
  DEVELOPMENT: "Development",
  QA: "QA",
  REVIEW: "Review",
};
export const retryStageLabel = (state: WorkState) => stageLabels[state] ?? state;

export function retry(store: Store, id: string) {
  const w = store.get(id);
  if (!w) throw new Error("Unknown work item");
  if (!retryable.includes(w.state)) throw new Error("Only failed, cancelled or paused items can retry");
  assertRetrySafe(store, id);
  const to = w.context.resume ?? "SPEC";
  delete w.context.lastFailure;
  store.transition(w, to);
  store.event("retry.requested", { to }, id);
  return to;
}
