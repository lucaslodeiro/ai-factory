import path from "node:path";

// One run of the benchmark issue, reduced to numbers that can be compared against another run.
// Everything here is read back from what the workflow already records; nothing is estimated and
// a value the provider did not report stays null rather than becoming zero.
export interface ExecutionSample {
  role:string; stage:string|null; status:string; startedAt:string|null; finishedAt:string|null;
  promptBytes:number|null; inputTokens:number|null; outputTokens:number|null;
  cacheReadTokens:number|null; cacheWriteTokens:number|null; totalTokens:number|null;
  turns:number|null; events:number|null; eventTypes:Record<string,number>;
  durationMs:number|null;
}
export interface TransitionSample { from:string; to:string; reason:string|null }
export interface BenchmarkInput {
  workItemId:string; issueNumber:number|null; stage:string|null; status:string|null;
  attempt:number; correctionCycles:number; specVersions:number;
  executions:ExecutionSample[]; transitions:TransitionSample[];
  outcomes:Array<{role:string;outcome:string}>;
  eventCounts:Record<string,number>;
}
export interface RoleMetrics {
  role:string; runs:number; turns:number|null; events:number|null;
  promptBytes:number|null; inputTokens:number|null; outputTokens:number|null;
  cacheReadTokens:number|null; cacheWriteTokens:number|null; totalTokens:number|null;
  durationMs:number|null; outcome:string|null;
}
// The run's own verdict is what the agents reported. `resolved` is what an independent oracle
// found by exercising the produced code. Only the second one can tell a cheaper run apart from
// a lazier one, so only runs that resolved the issue are comparable to each other.
// How the oracle is launched. It is a .mjs script that imports the TypeScript the run produced, so
// it needs tsx, and node resolves `--import tsx` against the working directory. Running it from the
// engine's own directory is what makes the operator's shell irrelevant: launched from a home
// directory it dies with ERR_MODULE_NOT_FOUND and the run reads as unresolved for a reason that has
// nothing to do with the code under test. The checkout is resolved before that move, not after it.
// Which checkout to grade. The run's worktree is `<dataDir>/worktrees/<work item id>`, so the
// operator never has to find and paste it: pasting a placeholder instead of the real path is how
// the first benchmark run reported a failure that had nothing to do with the code it produced.
export function benchmarkCheckout(value:string|boolean|undefined,workItemId:string,dataDir:string):string {
  return typeof value === "string" ? path.resolve(value) : path.join(dataDir,"worktrees",workItemId);
}
export function verifierInvocation(scriptPath:string,checkout:string):{command:string;args:string[];cwd:string} {
  return {command:process.execPath,args:["--import","tsx",scriptPath,path.resolve(checkout)],cwd:path.dirname(scriptPath)};
}
export interface Verification { resolved:boolean; module:string|null; failures:number|null; error:string|null;
  checks:Array<{behaviour:number;input:string;expected:string;actual:unknown;passed:boolean}> }
export interface BenchmarkReport {
  workItemId:string; issueNumber:number|null; stage:string|null; status:string|null;
  attempt:number; correctionCycles:number; specVersions:number;
  roles:RoleMetrics[]; totals:RoleMetrics;
  transitions:{count:number;path:string[];reasons:Record<string,number>};
  health:{failedExecutions:number;invalidResults:number;interruptions:number;discarded:number};
  verification:Verification|null;
}

const NUMERIC = ["turns","events","promptBytes","inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","totalTokens","durationMs"] as const;
type NumericField = typeof NUMERIC[number];
const add = (total:number|null, value:number|null) => value === null ? total : (total ?? 0)+value;
const round = (value:number|null) => value === null ? null : Math.round(value*1e6)/1e6;

function metrics(role:string, samples:ExecutionSample[], outcome:string|null):RoleMetrics {
  const totals = Object.fromEntries(NUMERIC.map(field=>[field,samples.reduce<number|null>((total,sample)=>add(total,sample[field]),null)])) as Record<NumericField,number|null>;
  return {role,runs:samples.length,...totals,outcome};
}

export function buildBenchmarkReport(input:BenchmarkInput & {verification?:Verification|null}):BenchmarkReport {
  const byRole=new Map<string,ExecutionSample[]>();
  for (const sample of input.executions) byRole.set(sample.role,[...(byRole.get(sample.role) ?? []),sample]);
  const outcome=(role:string)=>input.outcomes.filter(entry=>entry.role===role).at(-1)?.outcome ?? null;
  const roles=[...byRole.entries()].map(([role,samples])=>metrics(role,samples,outcome(role)))
    .sort((a,b)=>(b.totalTokens ?? 0)-(a.totalTokens ?? 0) || a.role.localeCompare(b.role));
  const reasons:Record<string,number>={};
  for (const transition of input.transitions) { const key=transition.reason ?? "unspecified"; reasons[key]=(reasons[key] ?? 0)+1; }
  const path=input.transitions.map(transition=>transition.to).filter((value,index,all)=>index===0 || all[index-1]!==value);
  return {
    workItemId:input.workItemId,issueNumber:input.issueNumber,stage:input.stage,status:input.status,
    attempt:input.attempt,correctionCycles:input.correctionCycles,specVersions:input.specVersions,
    roles,totals:{...metrics("ALL",input.executions,null),runs:input.executions.length},
    transitions:{count:input.transitions.length,path,reasons},
    health:{failedExecutions:input.executions.filter(sample=>sample.status!=="succeeded").length,
      invalidResults:input.eventCounts["execution.invalid_result"] ?? 0,
      interruptions:input.eventCounts["execution.interrupted"] ?? 0,
      discarded:input.eventCounts["execution.discarded"] ?? 0},
    verification:input.verification ?? null,
  };
}

export interface Comparison { metric:string; baseline:number|null; current:number|null; delta:number|null; percent:number|null }

// A metric missing on either side compares as unknown. Reporting a delta against a null would
// invent an improvement or a regression that was never measured.
export function compareBenchmarks(baseline:BenchmarkReport,current:BenchmarkReport,role="ALL"):Comparison[] {
  const pick=(report:BenchmarkReport)=>role==="ALL" ? report.totals : report.roles.find(entry=>entry.role===role) ?? null;
  const before=pick(baseline),after=pick(current);
  const fields:Array<[string,NumericField|"runs"]>=[["runs","runs"],["turns","turns"],["events","events"],["promptBytes","promptBytes"],
    ["inputTokens","inputTokens"],["outputTokens","outputTokens"],["cacheReadTokens","cacheReadTokens"],["cacheWriteTokens","cacheWriteTokens"],
    ["totalTokens","totalTokens"],["durationMs","durationMs"]];
  return fields.map(([metric,field])=>{
    const from=(before?.[field] ?? null) as number|null,to=(after?.[field] ?? null) as number|null;
    const delta=from === null || to === null ? null : round(to-from);
    return {metric,baseline:from,current:to,delta,percent:delta === null || !from ? null : Math.round((delta/from)*1000)/10};
  });
}

// A comparison between an unverified or unresolved run and anything else is worse than no
// comparison: it reads as a cost improvement when the cost fell because the work was not done.
export function comparable(baseline:BenchmarkReport,current:BenchmarkReport):string|null {
  for (const [label,report] of [["baseline",baseline],["current",current]] as const) {
    if (!report.verification) return `The ${label} run was never verified, so it cannot be compared. Re-run the report with --verify.`;
    if (!report.verification.resolved) return `The ${label} run did not resolve the benchmark issue, so its cost is not a measurement of doing the work.`;
  }
  return null;
}
