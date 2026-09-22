// Reads back what each provider run did, so a single issue answers whether a change helped.
// The comparison that matters is between roles on the same work item: the Builder receives a
// repository map and the Tester does not, so a map that saves exploration shows up as the
// Builder's events per run falling against the Tester's on the same issue.
export interface ActivityRow {
  role:string; stage:string|null; startedAt:string|null;
  events:number|null; eventTypes:Record<string,number>; turns:number|null;
  cacheReadTokens:number|null; cacheWriteTokens:number|null; outputTokens:number|null;
}
export interface RoleActivity {
  role:string; runs:number; events:number|null; eventsPerRun:number|null; turns:number|null;
  cacheReadTokens:number|null; cacheWriteTokens:number|null; outputTokens:number|null; topTypes:string;
}

const add = (total:number|null, value:number|null) => value === null ? total : (total ?? 0)+value;

export function summarizeActivity(rows:ActivityRow[]):RoleActivity[] {
  const byRole=new Map<string,ActivityRow[]>();
  for (const row of rows) byRole.set(row.role,[...(byRole.get(row.role) ?? []),row]);
  return [...byRole.entries()].map(([role,runs])=>{
    const sum=(field:"events"|"turns"|"cacheReadTokens"|"cacheWriteTokens"|"outputTokens")=>runs.reduce<number|null>((total,row)=>add(total,row[field]),null);
    const types=new Map<string,number>();
    for (const row of runs) for (const [type,count] of Object.entries(row.eventTypes)) types.set(type,(types.get(type) ?? 0)+count);
    const events=sum("events");
    return {role,runs:runs.length,events,eventsPerRun:events === null ? null : Math.round(events/runs.length),
      turns:sum("turns"),cacheReadTokens:sum("cacheReadTokens"),cacheWriteTokens:sum("cacheWriteTokens"),outputTokens:sum("outputTokens"),
      topTypes:[...types.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,4).map(([type,count])=>`${type}:${count}`).join(" ")};
  }).sort((a,b)=>(b.events ?? 0)-(a.events ?? 0) || a.role.localeCompare(b.role));
}

export function activityRow(payload:unknown, role:string, stage:string|null, startedAt:string|null):ActivityRow {
  const event=(payload && typeof payload === "object" ? payload : {}) as Record<string,unknown>;
  const activity=(event.activity && typeof event.activity === "object" ? event.activity : {}) as Record<string,unknown>;
  const usage=(event.usage && typeof event.usage === "object" ? event.usage : {}) as Record<string,unknown>;
  const number=(value:unknown)=>typeof value === "number" && Number.isFinite(value) ? value : null;
  const types=activity.eventTypes && typeof activity.eventTypes === "object" ? activity.eventTypes as Record<string,number> : {};
  return {role,stage,startedAt,events:number(activity.events),eventTypes:types,turns:number(activity.turns),
    cacheReadTokens:number(usage.cacheReadTokens),cacheWriteTokens:number(usage.cacheWriteTokens),outputTokens:number(usage.outputTokens)};
}
