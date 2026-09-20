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

function distance(a:string,b:string){const row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let previous=row[0];row[0]=i;for(let j=1;j<=b.length;j++){const saved=row[j];row[j]=Math.min(row[j]+1,row[j-1]+1,previous+(a[i-1]===b[j-1]?0:1));previous=saved;}}return row[b.length];}

export function factoryCommandTypo(body:string){const lines=body.trim().split(/\r?\n/).map(line=>line.trim()).filter(Boolean),candidates=[lines[0],lines.at(-1)].filter((line,index,array):line is string=>Boolean(line)&&array.indexOf(line)===index);for(const line of candidates){const match=line.match(/^\/([^\s/]+)(?:\s+([^\s]+))?/);if(!match||match[1]==="factory"||distance(match[1].toLowerCase(),"factory")>2)continue;const attempt=`/${match[1]}${match[2]?` ${match[2]}`:""}`;return {attempt,suggestion:attempt.replace(`/${match[1]}`,"/factory")};}return null;}

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
 const lines=trimmed.split(/\r?\n/),nonempty=lines.map((line,index)=>({line:line.trim(),index})).filter(value=>value.line),firstEntry=nonempty[0],lastEntry=nonempty.at(-1)!;
 const selected=firstEntry.line.startsWith("/factory ")?firstEntry:lastEntry.line.startsWith("/factory ")?lastEntry:null;
 if(!selected)return null;
 const commandLine=selected.line,payload=lines.filter((_,index)=>index!==selected.index).join("\n").trim();
 if (commandLine==="/factory help") return {kind:"help"};
 const answer=commandLine.match(/^\/factory answer(?:\s+(.*))?$/);
 if (answer) {const text=[answer[1]??"",payload].filter(Boolean).join("\n").trim();if(!text)throw new Error("/factory answer requires guidance");return {kind:"answer",text};}
 const retry=commandLine.match(/^\/factory retry(?:\s+(.*))?$/);
 if (retry) {const parsed=scoped([retry[1]??"",payload].filter(Boolean).join("\n"));return {kind:"retry",guidance:parsed.text,scope:parsed.scope,appliesTo:parsed.appliesTo};}
 const start=commandLine.match(/^\/factory start(?:\s+(.*))?$/);
 if (start) return {kind:"start",guidance:[start[1]??"",payload].filter(Boolean).join("\n").trim()};
 const pause=commandLine.match(/^\/factory pause(?:\s+(.*))?$/);
 if (pause) return {kind:"pause",reason:[pause[1]??"",payload].filter(Boolean).join("\n").trim()};
 const cancel=commandLine.match(/^\/factory cancel(?:\s+(.*))?$/);
 if (cancel) return {kind:"cancel",reason:[cancel[1]??"",payload].filter(Boolean).join("\n").trim()};
 const approve=commandLine.match(/^\/factory approve v(\d+)(?:\s+(.*))?$/);
 if (approve) return {kind:"approve",version:Number(approve[1]),guidance:[approve[2]??"",payload].filter(Boolean).join("\n").trim()};
 const revoke=commandLine.match(/^\/factory revoke (#[1-9]\d*|[a-zA-Z0-9-]+)$/);
 if (revoke) return {kind:"revoke",recordId:revoke[1]};
 const note=commandLine.match(/^\/factory note(?:\s+(.*))?$/);
 if (note) {
  const parsed=scoped([note[1]??"",payload].filter(Boolean).join("\n"));
  if(!parsed.text)throw new Error("/factory note requires instruction text");return {kind:"note",...parsed};
 }
 const replace=commandLine.match(/^\/factory replace\s+(#[1-9]\d*|[a-zA-Z0-9-]+)(?:\s+(.*))?$/);
 if (replace) {
  const parsed=scoped([replace[2]??"",payload].filter(Boolean).join("\n"));
  if(!parsed.text)throw new Error("/factory replace requires replacement text");return {kind:"replace",recordId:replace[1],...parsed};
 }
 throw new Error("Unknown or malformed /factory command");
}
