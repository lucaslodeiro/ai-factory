import type { AgentRole } from "./types.js";
import type { RecordScope } from "./workflow-records.js";

export type FactoryCommand=
 | {kind:"start";guidance:string}
 | {kind:"help"}
 | {kind:"approve";version:number;guidance:string}
 | {kind:"answer";text:string}
 | {kind:"retry";guidance:string;scope:RecordScope;appliesTo:AgentRole[]}
 | {kind:"note";text:string;scope:RecordScope;appliesTo:AgentRole[]}
 | {kind:"replace";recordId:string;text:string;scope:RecordScope;appliesTo:AgentRole[]}
 | {kind:"revoke";recordId:string}
 | {kind:"pause";reason:string}
 | {kind:"cancel";reason:string};

const roles:Record<string,AgentRole>={architect:"product-architect",builder:"developer",tester:"qa",reviewer:"reviewer"};

function scoped(rest:string) {
  let scope:RecordScope="spec",appliesTo:AgentRole[]=[];
  let remaining=rest.trim();
  while (remaining.startsWith("--")) {
   const issue=remaining.match(/^--issue(?:\s+|$)/);
   if (issue) {scope="issue";remaining=remaining.slice(issue[0].length).trimStart();continue;}
   const selected=remaining.match(/^--for\s+([^\s]+)(?:\s+|$)/);
   if (selected) {
    appliesTo=selected[1].split(",").map(name=>{const role=roles[name.toLowerCase()];if(!role)throw new Error(`Unknown role ${name}; use architect, builder, tester or reviewer`);return role;});
    appliesTo=[...new Set(appliesTo)];remaining=remaining.slice(selected[0].length).trimStart();continue;
   }
   if (remaining==="--for") throw new Error("--for requires a comma-separated role list");
   throw new Error(`Unknown command option ${remaining.split(/\s/,1)[0]}`);
  }
  return {scope,appliesTo,text:remaining.trim()};
}

export function parseFactoryCommand(body:string):FactoryCommand|null {
 const trimmed=body.trim();if (!trimmed) return null;
 const lines=trimmed.split(/\r?\n/),first=lines[0].trim(),continuation=lines.slice(1).join("\n").trim();
 if (!first.startsWith("/factory ")) return null;
 if (first==="/factory help") return {kind:"help"};
 const answer=first.match(/^\/factory answer(?:\s+(.*))?$/);
 if (answer) {const text=[answer[1]??"",continuation].filter(Boolean).join("\n").trim();if(!text)throw new Error("/factory answer requires guidance");return {kind:"answer",text};}
 const retry=first.match(/^\/factory retry(?:\s+(.*))?$/);
 if (retry) {const parsed=scoped([retry[1]??"",continuation].filter(Boolean).join("\n"));return {kind:"retry",guidance:parsed.text,scope:parsed.scope,appliesTo:parsed.appliesTo};}
 const start=first.match(/^\/factory start(?:\s+(.*))?$/);
 if (start) return {kind:"start",guidance:[start[1]??"",continuation].filter(Boolean).join("\n").trim()};
 const pause=first.match(/^\/factory pause(?:\s+(.*))?$/);
 if (pause) return {kind:"pause",reason:[pause[1]??"",continuation].filter(Boolean).join("\n").trim()};
 const cancel=first.match(/^\/factory cancel(?:\s+(.*))?$/);
 if (cancel) return {kind:"cancel",reason:[cancel[1]??"",continuation].filter(Boolean).join("\n").trim()};
 const approve=first.match(/^\/factory approve v(\d+)(?:\s+(.*))?$/);
 if (approve) return {kind:"approve",version:Number(approve[1]),guidance:[approve[2]??"",continuation].filter(Boolean).join("\n").trim()};
 const revoke=first.match(/^\/factory revoke ([a-zA-Z0-9-]+)$/);
 if (revoke) return {kind:"revoke",recordId:revoke[1]};
 const note=first.match(/^\/factory note(?:\s+(.*))?$/);
 if (note) {
  const parsed=scoped([note[1]??"",continuation].filter(Boolean).join("\n"));
  if(!parsed.text)throw new Error("/factory note requires instruction text");return {kind:"note",...parsed};
 }
 const replace=first.match(/^\/factory replace\s+([a-zA-Z0-9-]+)(?:\s+(.*))?$/);
 if (replace) {
  const parsed=scoped([replace[2]??"",continuation].filter(Boolean).join("\n"));
  if(!parsed.text)throw new Error("/factory replace requires replacement text");return {kind:"replace",recordId:replace[1],...parsed};
 }
 throw new Error("Unknown or malformed /factory command");
}
