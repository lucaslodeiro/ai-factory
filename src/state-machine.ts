import type { WorkState } from "./types.js";
const active: WorkState[] = ["SPEC", "DEVELOPMENT", "QA", "REVIEW"];
const allowed: Record<WorkState, WorkState[]> = {
 NEW: ["SPEC", "CANCELLED"], SPEC: ["DEVELOPMENT", "QA", "REVIEW", "WAITING_HUMAN", "FAILED", "CANCELLED", "PAUSED"],
 WAITING_HUMAN: ["SPEC", "DEVELOPMENT", "CANCELLED", "FAILED", "PAUSED"],
 DEVELOPMENT: ["QA", "SPEC", "WAITING_HUMAN", "FAILED", "CANCELLED", "PAUSED"],
 QA: ["DEVELOPMENT", "SPEC", "WAITING_HUMAN", "REVIEW", "FAILED", "CANCELLED", "PAUSED"],
 REVIEW: ["DEVELOPMENT", "SPEC", "WAITING_HUMAN", "READY_TO_MERGE", "FAILED", "CANCELLED", "PAUSED"],
 READY_TO_MERGE: ["MERGED", "PR_CLOSED", "CANCELLED"], MERGED: [], PR_CLOSED: ["READY_TO_MERGE", "MERGED", "CANCELLED"], PAUSED: [...active, "WAITING_HUMAN", "CANCELLED"],
 FAILED: [...active, "WAITING_HUMAN", "CANCELLED"], CANCELLED: [...active, "WAITING_HUMAN"],
};
export function canTransition(from: WorkState, to: WorkState) { return allowed[from].includes(to); }
export function assertTransition(from: WorkState, to: WorkState) { if (!canTransition(from, to)) throw new Error(`Invalid transition ${from} -> ${to}`); }
