import type { AgentProvider } from "./types.js";

// cachedTokens keeps the historical sum for the executions table. The split matters because a
// cache write is a miss that populated the cache and a cache read is a hit: summed, an improvement
// and a regression look identical. It rides the execution.finished event, so no schema change.
export interface TokenUsage { inputTokens:number|null; outputTokens:number|null; cachedTokens:number|null; cacheReadTokens:number|null; cacheWriteTokens:number|null; totalTokens:number|null; }
const number = (value:unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const first = (...values:unknown[]) => values.map(number).find(value=>value !== null) ?? null;

function usageFromObject(value:unknown): TokenUsage | null {
 if (!value || typeof value !== "object") return null;
 const item=value as Record<string,unknown>;
 const input=first(item.input_tokens,item.inputTokens);
 const output=first(item.output_tokens,item.outputTokens);
 const cacheRead=first(item.cache_read_input_tokens,item.cacheReadInputTokens) ?? 0;
 const cacheCreate=first(item.cache_creation_input_tokens,item.cacheCreationInputTokens) ?? 0;
 const cached=cacheRead+cacheCreate || null;
 const explicit=first(item.total_tokens,item.totalTokens);
 if (input === null && output === null && cached === null && explicit === null) return null;
 return {inputTokens:input,outputTokens:output,cachedTokens:cached,cacheReadTokens:cached === null ? null : cacheRead,cacheWriteTokens:cached === null ? null : cacheCreate,totalTokens:explicit ?? (input ?? 0)+(output ?? 0)+(cached ?? 0)};
}

function merge(values:TokenUsage[]) {
 if (!values.length) return null;
 const sum=(field:keyof TokenUsage)=>values.some(value=>value[field] !== null) ? values.reduce((total,value)=>total+(value[field] ?? 0),0) : null;
 return {inputTokens:sum("inputTokens"),outputTokens:sum("outputTokens"),cachedTokens:sum("cachedTokens"),cacheReadTokens:sum("cacheReadTokens"),cacheWriteTokens:sum("cacheWriteTokens"),totalTokens:sum("totalTokens")};
}

export function extractTokenUsage(provider: AgentProvider | undefined,stdout: string,stderr: string): TokenUsage | null {
 if (provider === "codex") {
  const match=[...stderr.matchAll(/tokens used\s*(?:\r?\n|:)\s*([\d,]+)/gi)].at(-1);
  if (match) return {inputTokens:null,outputTokens:null,cachedTokens:null,cacheReadTokens:null,cacheWriteTokens:null,totalTokens:Number(match[1].replaceAll(",",""))};
 }
 const envelopes:unknown[]=[];
 for (const line of stdout.split(/\r?\n/).filter(Boolean)) try { envelopes.push(JSON.parse(line)); } catch {}
 const direct=envelopes.map(envelope=>usageFromObject((envelope as Record<string,unknown>)?.usage)).filter(Boolean) as TokenUsage[];
 if (direct.length) return direct.at(-1)!;
 const modelUsage=envelopes.flatMap(envelope=>{
  const models=(envelope as Record<string,unknown>)?.modelUsage;
  return models && typeof models === "object" ? Object.values(models as Record<string,unknown>).map(usageFromObject).filter(Boolean) as TokenUsage[] : [];
 });
 return merge(modelUsage);
}
