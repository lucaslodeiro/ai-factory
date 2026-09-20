export interface LogEntry {text:string;error:boolean;timestamp?:string}
export function logEntries(logs:Array<{content:string;exists:boolean}>):LogEntry[]{
 const entries:LogEntry[]=[];
 for(const log of logs){if(!log.exists)continue;let previous:LogEntry|undefined;
  for(const line of log.content.split(/\r?\n/)){
   if(!line.trim())continue;
   const structured=line.match(/^(\d{4}-\d\d-\d\dT\S+)\s+(INFO|WARN|ERROR|FATAL)\s+(\S+)/);
   const failure=/\b(?:[\w.]*Error|error|fatal|failed|failure|exception)\b/i.test(line);
   // Preserve stack frames and indented details with their originating message.
   if(!structured&&previous&&/^\s+/.test(line)){previous.text+='\n'+line;continue;}
   const error=structured?['ERROR','FATAL'].includes(structured[2])||/(?:^|[._])failed$/.test(structured[3])||/\bstatus="failed"/.test(line):failure;
   previous={text:line,error,...(structured?{timestamp:structured[1]}:{})};entries.push(previous);
  }
 }
 // Timestamped messages from both streams share one chronological view.
 return entries.map((entry,index)=>({entry,index})).sort((a,b)=>a.entry.timestamp&&b.entry.timestamp?a.entry.timestamp.localeCompare(b.entry.timestamp)||a.index-b.index:a.entry.timestamp?-1:b.entry.timestamp?1:a.index-b.index).map(({entry})=>entry);
}
