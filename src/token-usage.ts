import type { AgentProvider } from "./types.js";

// cachedTokens keeps the historical sum for the executions table. The split matters because a
// cache write is a miss that populated the cache and a cache read is a hit: summed, an improvement
// and a regression look identical. It rides the execution.finished event, so no schema change.
// `partial` marks a run that stopped before the provider stated its total: what is recorded is the
// sum of what it had reported by then, a lower bound and never an estimate. The issue budget counts
// it; a run with no usage at all stays unknown.
export interface TokenUsage { inputTokens:number|null; outputTokens:number|null; cachedTokens:number|null; cacheReadTokens:number|null; cacheWriteTokens:number|null; totalTokens:number|null; partial?:boolean; }
/** The tokens the provider's CLI reported for a run, as it reported them: nothing is priced or
 * weighted. A Cursor report without its cache breakdown leaves the cache out of the total, so it is
 * not the run's consumption and stays unknown rather than reading low. */
export function reportedTokens(usage:Partial<TokenUsage>|null|undefined,provider?:AgentProvider|null):number|null {
 if(!usage||usage.totalTokens===null||usage.totalTokens===undefined)return null;
 if(provider==="cursor"&&(usage.cacheReadTokens===null||usage.cacheReadTokens===undefined||usage.cacheWriteTokens===null||usage.cacheWriteTokens===undefined))return null;
 return Math.round(usage.totalTokens);
}
/** A run's own share of a thread total: Codex reports a resumed thread's running total, so a resumed
 * run is that total less what the thread had already reported when the previous run ended. */
export function sinceSessionTotal(usage:TokenUsage|null,baseline:Partial<TokenUsage>|null|undefined):TokenUsage|null {
 if(!usage||!baseline)return usage;
 const less=(field:Exclude<keyof TokenUsage,"partial">)=>usage[field]===null?null:Math.max(0,usage[field]!-(baseline[field]??0));
 return {...usage,inputTokens:less("inputTokens"),outputTokens:less("outputTokens"),cachedTokens:less("cachedTokens"),cacheReadTokens:less("cacheReadTokens"),cacheWriteTokens:less("cacheWriteTokens"),totalTokens:less("totalTokens")};
}
const number = (value:unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const first = (...values:unknown[]) => values.map(number).find(value=>value !== null) ?? null;

function usageFromObject(value:unknown): TokenUsage | null {
 if (!value || typeof value !== "object") return null;
 const item=value as Record<string,unknown>;
 const input=first(item.input_tokens,item.inputTokens);
 const output=first(item.output_tokens,item.outputTokens);
 const cacheRead=first(item.cache_read_input_tokens,item.cacheReadInputTokens,item.cacheReadTokens) ?? 0;
 const cacheCreate=first(item.cache_creation_input_tokens,item.cacheCreationInputTokens,item.cacheWriteTokens) ?? 0;
 const cached=cacheRead+cacheCreate || null;
 const explicit=first(item.total_tokens,item.totalTokens);
 if (input === null && output === null && cached === null && explicit === null) return null;
 return {inputTokens:input,outputTokens:output,cachedTokens:cached,cacheReadTokens:cached === null ? null : cacheRead,cacheWriteTokens:cached === null ? null : cacheCreate,totalTokens:explicit ?? (input ?? 0)+(output ?? 0)+(cached ?? 0)};
}

function merge(values:TokenUsage[]) {
 if (!values.length) return null;
 const sum=(field:Exclude<keyof TokenUsage,"partial">)=>values.some(value=>value[field] !== null) ? values.reduce((total,value)=>total+(value[field] ?? 0),0) : null;
 return {inputTokens:sum("inputTokens"),outputTokens:sum("outputTokens"),cachedTokens:sum("cachedTokens"),cacheReadTokens:sum("cacheReadTokens"),cacheWriteTokens:sum("cacheWriteTokens"),totalTokens:sum("totalTokens")};
}

// Codex reports usage on every turn.completed event, with cached input counted inside input_tokens
// (OpenAI semantics); a run is the sum of its turns. Claude and Cursor state the whole run's usage
// once, on the result envelope, with input_tokens excluding the cache (Anthropic semantics).
function codexTurnUsage(value:unknown):TokenUsage|null {
 if (!value || typeof value !== "object") return null;
 const item=value as Record<string,unknown>;
 const input=number(item.input_tokens),output=number(item.output_tokens),cacheRead=number(item.cached_input_tokens) ?? 0,cacheWrite=number(item.cache_write_input_tokens) ?? 0;
 if (input === null && output === null) return null;
 const cached=cacheRead+cacheWrite;
 return {inputTokens:input === null ? null : Math.max(0,input-cached),outputTokens:output,cachedTokens:cached,cacheReadTokens:cacheRead,cacheWriteTokens:cacheWrite,totalTokens:(input ?? 0)+(output ?? 0)};
}

/** Folds a provider's events, one at a time, into the usage it reported. Nothing is estimated. */
export function tokenUsageReducer(provider: AgentProvider | undefined) {
 const turns:TokenUsage[]=[];let direct:TokenUsage|null=null,models:TokenUsage[]=[];
 // Before its result, Claude states each API response's usage on its assistant events. Parallel tool
 // calls repeat one response under the same message id, so each id counts once; subagent responses
 // are left out like the result's own usage leaves them out. Their output count is only the one known
 // when the response started, which is why a run cut before its result is partial.
 const steps=new Map<string,TokenUsage>();
 return {
  add(event:Record<string,unknown>) {
   if (provider === "codex") { if (event.type === "turn.completed") { const usage=codexTurnUsage(event.usage); if (usage) turns.push(usage); } return; }
   if (event.type === "assistant" && !event.parent_tool_use_id && event.message && typeof event.message === "object") {
    const message=event.message as Record<string,unknown>,usage=typeof message.id === "string" && !steps.has(message.id) ? usageFromObject(message.usage) : null;
    if (usage) steps.set(message.id as string,usage);
    return;
   }
   const usage=usageFromObject(event.usage);
   if (usage) direct=usage;
   const byModel=event.modelUsage;
   if (byModel && typeof byModel === "object") { const values=Object.values(byModel as Record<string,unknown>).map(usageFromObject).filter(Boolean) as TokenUsage[]; if (values.length) models=values; }
  },
  result():TokenUsage|null {
   if (provider === "codex") return merge(turns);
   const stated=direct ?? merge(models);
   if (stated) return stated;
   const cut=merge([...steps.values()]);
   return cut ? {...cut,partial:true} : null;
  },
 };
}
