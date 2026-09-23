import type { AgentRole } from "./types.js";

export const roleNames: Record<AgentRole,{ full: string; short: string; stage: string }> = {
  "product-architect": { full:"Product Architect", short:"Architect", stage:"Design" },
  designer: { full:"Product Designer", short:"Designer", stage:"Design" },
  developer: { full:"Implementation Engineer", short:"Builder", stage:"Build" },
  qa: { full:"Verification Engineer", short:"Tester", stage:"Test" },
  reviewer: { full:"Delivery Reviewer", short:"Reviewer", stage:"Review" },
};

export const stateNames: Record<string,string> = {
  DESIGN:"Design", BUILD:"Build", TEST:"Test", REVIEW:"Review", DELIVERY:"Delivery",
  QUEUED:"Queued", RUNNING:"Running", WAITING:"Waiting for you", COMPLETED:"Completed",
  PAUSED:"Paused",
  FAILED:"Failed",
  CANCELLED:"Cancelled",
};

export const roleFullName = (role: AgentRole | string) => roleNames[role as AgentRole]?.full ?? role;
export const roleShortName = (role: AgentRole | string) => roleNames[role as AgentRole]?.short ?? role;
export const roleStageName = (role: AgentRole | string) => roleNames[role as AgentRole]?.stage ?? role;
export const stateName = (state: string) => stateNames[state] ?? state;

export const publicNaming = {
  roles: roleNames,
  states: stateNames,
};
