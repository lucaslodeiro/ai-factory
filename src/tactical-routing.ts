import type { DeliveryStage } from "./types.js";

export type TacticalNextRole = "developer" | "qa" | "reviewer";

const routes: Record<DeliveryStage, TacticalNextRole[]> = {
  BUILD: ["developer"],
  TEST: ["developer", "qa"],
  REVIEW: ["developer", "qa", "reviewer"],
};

export function allowedTacticalNextRoles(from: DeliveryStage): TacticalNextRole[] {
  return [...routes[from]];
}

export function deliveryStageName(stage: DeliveryStage) {
  return ({ BUILD: "Build", TEST: "Test", REVIEW: "Review" } as const)[stage];
}

export function tacticalRouteError(selected: TacticalNextRole, allowed: TacticalNextRole[], from?: DeliveryStage) {
  const origin = from ? ` after a ${deliveryStageName(from)} consultation` : "";
  return `Tactical resolution selected nextRole=${selected}${origin}; allowed nextRole value${allowed.length === 1 ? " is" : "s are"}: ${allowed.join(", ")}. Returning a later role would skip an unfinished delivery gate.`;
}
