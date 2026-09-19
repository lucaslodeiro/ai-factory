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
  if (to === "SPEC" && ["loop","questions"].includes(w.context.waiting ?? "") && !w.context.consultation) {
    const stages: Array<[AgentRole,DeliveryStage]> = [["reviewer","REVIEW"],["qa","QA"],["developer","DEVELOPMENT"]];
    const recovered = stages.find(([role]) => {
      const report=w.context.reports[role];
      return report && (report.outcome === "changes" || report.outcome === "decision" || report.findings.some(f => f.classification === "auto-fix" || f.classification === "decision-required"));
    });
    if (recovered) {
      // Older releases erased approval together with the consultation route
      // when Architect asked a follow-up question. The immutable approval
      // event lets us repair that state without inventing a new approval.
      if (w.context.approvedVersion !== w.context.version) {
        const row=store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='spec.approved' ORDER BY id DESC LIMIT 1").get(id) as {payload:string} | undefined;
        try {
          const approval=JSON.parse(row?.payload ?? "{}") as {version?:number;login?:string;commentId?:number};
          if (approval.version === w.context.version && approval.login && approval.commentId) {
            w.context.approvedVersion=approval.version;
            w.context.approval={login:approval.login,commentId:approval.commentId};
          }
        } catch {}
      }
      if (w.context.approvedVersion === w.context.version) {
        w.context.consultation = { from:recovered[1] };
        store.event("consultation.recovered",{from:recovered[1],specVersion:w.context.version},id);
      }
    }
  }
  delete w.context.lastFailure;
  store.transition(w, to);
  store.event("retry.requested", { to }, id);
  return to;
}
