import { config } from "./config.js";
import type { AgentRole, ModelSelection } from "./types.js";

export interface ResolvedContextBudget { bytes:number;source:string; }

export function resolveContextBudget(role:AgentRole,selection:Pick<ModelSelection,"provider"|"model">,settings=config.contextBudget):ResolvedContextBudget {
  const modelKey=`${selection.provider}/${selection.model}`;
  if (selection.model !== "auto" && settings.overrides[modelKey] !== undefined) return {bytes:settings.overrides[modelKey],source:`provider/model:${modelKey}`};
  if (settings.overrides[role] !== undefined) return {bytes:settings.overrides[role],source:`role:${role}`};
  return {bytes:settings.defaultBytes,source:"default"};
}
