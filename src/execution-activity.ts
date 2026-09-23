// Reads back what each provider run did, so a single issue answers whether a change helped.
// The comparison that matters is between roles on the same work item: the Builder receives a
// repository map and the Tester does not, so a map that saves exploration shows up as the
// Builder's events per run falling against the Tester's on the same issue.
export interface ActivityRow {
  role:string; stage:string|null; startedAt:string|null;
  events:number|null; eventTypes:Record<string,number>; turns:number|null;
  cacheReadTokens:number|null; cacheWriteTokens:number|null; outputTokens:number|null;
  totalTokens:number|null; costUsd:number|null; durationMs:number|null;
}

// Does a correction cycle get cheaper? The second run of a role already has the findings and the
// code it wrote, so it should cost less than the first. If it does not, the role is starting over
// each cycle, and that is worth more than any prompt-size work: one cycle re-runs Builder and
// Tester, which on a measured issue was 90% of its cost.
export interface RunProgression {
  role:string; run:number; stage:string|null; turns:number|null; events:number|null;
  totalTokens:number|null; costUsd:number|null; durationMs:number|null;
  vsPreviousPercent:number|null; vsFirstPercent:number|null;
}
export function progression(rows:ActivityRow[]):RunProgression[] {
  const byRole=new Map<string,ActivityRow[]>();
  for (const row of rows) byRole.set(row.role,[...(byRole.get(row.role) ?? []),row]);
  const result:RunProgression[]=[];
  for (const [role,unsorted] of byRole) {
    if (unsorted.length < 2) continue;
    const runs=[...unsorted].sort((a,b)=>String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
    // Cost is the comparison when the provider reports it, tokens otherwise. A run missing both
    // compares as unknown rather than as an improvement.
    const basis=(row:ActivityRow)=>row.costUsd ?? row.totalTokens;
    const change=(from:number|null,to:number|null)=>from === null || to === null || !from ? null : Math.round(((to-from)/from)*1000)/10;
    const first=basis(runs[0]);
    // Run over run is the honest reading of "does a cycle get cheaper". A first run that aborted
    // early is a tiny baseline that makes every later run look like a catastrophic regression,
    // which real data showed: two 23K and 57K stubs preceding runs above a million.
    let previous:number|null=null;
    runs.forEach((row,index)=>{
      const value=basis(row);
      result.push({role,run:index+1,stage:row.stage,turns:row.turns,events:row.events,
        totalTokens:row.totalTokens,costUsd:row.costUsd,durationMs:row.durationMs,
        vsPreviousPercent:index===0 ? null : change(previous,value),
        vsFirstPercent:index===0 ? null : change(first,value)});
      if (value !== null) previous=value;
    });
  }
  return result;
}
export interface RoleActivity {
  role:string; runs:number; events:number|null; eventsPerRun:number|null; turns:number|null;
  cacheReadTokens:number|null; cacheWriteTokens:number|null; outputTokens:number|null;
  totalTokens:number|null; costUsd:number|null; topTypes:string;
}

const add = (total:number|null, value:number|null) => value === null ? total : (total ?? 0)+value;

export function summarizeActivity(rows:ActivityRow[]):RoleActivity[] {
  const byRole=new Map<string,ActivityRow[]>();
  for (const row of rows) byRole.set(row.role,[...(byRole.get(row.role) ?? []),row]);
  return [...byRole.entries()].map(([role,runs])=>{
    const sum=(field:"events"|"turns"|"cacheReadTokens"|"cacheWriteTokens"|"outputTokens"|"totalTokens"|"costUsd")=>runs.reduce<number|null>((total,row)=>add(total,row[field]),null);
    const types=new Map<string,number>();
    for (const row of runs) for (const [type,count] of Object.entries(row.eventTypes)) types.set(type,(types.get(type) ?? 0)+count);
    const events=sum("events"),cost=sum("costUsd");
    return {role,runs:runs.length,events,eventsPerRun:events === null ? null : Math.round(events/runs.length),
      turns:sum("turns"),cacheReadTokens:sum("cacheReadTokens"),cacheWriteTokens:sum("cacheWriteTokens"),outputTokens:sum("outputTokens"),
      totalTokens:sum("totalTokens"),costUsd:cost===null ? null : Math.round(cost*1e6)/1e6,
      topTypes:[...types.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,4).map(([type,count])=>`${type}:${count}`).join(" ")};
  // The objective is stated in cost, and event counts are shaped by each provider's stream, so an
  // events-first ordering compares formats rather than work. Cost leads where it was reported.
  }).sort((a,b)=>(b.costUsd ?? 0)-(a.costUsd ?? 0) || (b.totalTokens ?? 0)-(a.totalTokens ?? 0) ||
    (b.events ?? 0)-(a.events ?? 0) || a.role.localeCompare(b.role));
}

export function activityRow(payload:unknown, role:string, stage:string|null, startedAt:string|null):ActivityRow {
  const event=(payload && typeof payload === "object" ? payload : {}) as Record<string,unknown>;
  const activity=(event.activity && typeof event.activity === "object" ? event.activity : {}) as Record<string,unknown>;
  const usage=(event.usage && typeof event.usage === "object" ? event.usage : {}) as Record<string,unknown>;
  const number=(value:unknown)=>typeof value === "number" && Number.isFinite(value) ? value : null;
  const types=activity.eventTypes && typeof activity.eventTypes === "object" ? activity.eventTypes as Record<string,number> : {};
  return {role,stage,startedAt,events:number(activity.events),eventTypes:types,turns:number(activity.turns),
    cacheReadTokens:number(usage.cacheReadTokens),cacheWriteTokens:number(usage.cacheWriteTokens),outputTokens:number(usage.outputTokens),
    totalTokens:number(usage.totalTokens),costUsd:number(activity.costUsd),durationMs:number(activity.durationMs)};
}
