import type { AgentRole, WorkState } from "./types.js";

export const roleNames: Record<AgentRole,{ full: string; short: string; stage: string }> = {
  "product-architect": { full:"Product Architect", short:"Architect", stage:"Design" },
  developer: { full:"Implementation Engineer", short:"Builder", stage:"Build" },
  qa: { full:"Verification Engineer", short:"Tester", stage:"Test" },
  reviewer: { full:"Delivery Reviewer", short:"Reviewer", stage:"Review" },
};

export const stateNames: Record<WorkState,string> = {
  NEW:"Queued",
  SPEC:"Design",
  WAITING_HUMAN:"Waiting for input",
  DEVELOPMENT:"Build",
  QA:"Test",
  REVIEW:"Review",
  READY_TO_MERGE:"Ready to merge",
  MERGED:"Merged",
  PR_CLOSED:"PR closed",
  PAUSED:"Paused",
  FAILED:"Failed",
  CANCELLED:"Cancelled",
};

export const roleFullName = (role: AgentRole | string) => roleNames[role as AgentRole]?.full ?? role;
export const roleShortName = (role: AgentRole | string) => roleNames[role as AgentRole]?.short ?? role;
export const roleStageName = (role: AgentRole | string) => roleNames[role as AgentRole]?.stage ?? role;
export const stateName = (state: WorkState | string) => stateNames[state as WorkState] ?? state;

export const publicNaming = {
  roles: roleNames,
  states: stateNames,
};
