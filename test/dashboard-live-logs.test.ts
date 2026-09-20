import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8');
test('copy feedback survives asynchronous clipboard completion and reports failure',async()=>{
 const messages:string[]=[],timers:(()=>void)[]=[];let finish!:(value:boolean)=>void;
 const context=vm.createContext({copyText:()=>new Promise<boolean>(resolve=>finish=resolve),toast:(s:string)=>messages.push(s),setTimeout:(callback:()=>void)=>timers.push(callback)});
 vm.runInContext(source.split('\n').find(line=>line.startsWith('async function copyWithFeedback('))!,context);
 const button={textContent:'Copy logs',disabled:false};context.button=button;
 const result=vm.runInContext("copyWithFeedback(button,'logs','Logs')",context);assert.equal(button.disabled,true);finish(true);await result;assert.equal(button.textContent,'Copied!');assert.deepEqual(messages,['Logs copied.']);timers.shift()!();assert.equal(button.disabled,false);
 context.copyText=async()=>{throw new Error('Denied');};await vm.runInContext("copyWithFeedback(button,'logs','Logs')",context);assert.equal(button.textContent,'Copy failed');assert.match(messages.at(-1)!,/Could not copy/);
});
test('log polling recovers after a timed out request and also updates a collapsed panel',async()=>{
 const elements=new Map<string,any>();let calls=0,renders=0;
 const context=vm.createContext({AbortSignal,encodeURIComponent,$:(id:string)=>{if(!elements.has(id))elements.set(id,{open:false,value:'200',classList:{remove(){}}});return elements.get(id)},pollingFetch:async(_url:string,options:any)=>{assert.ok(options.signal);assert.equal(options.cache,'no-store');if(++calls===1)throw new Error('Timed out');return {ok:true,json:async()=>({logs:[]})}},pollingInterrupted:()=>false,renderDaemonLogs:()=>renders++});
 vm.runInContext('let daemonLogsLoading=false,daemonLogsData=null;',context);
 const start=source.indexOf('async function loadDaemonLogs(){'),end=source.indexOf("\n$('#daemon-logs-panel')",start);vm.runInContext(source.slice(start,end),context);
 await vm.runInContext('loadDaemonLogs()',context);assert.equal(vm.runInContext('daemonLogsLoading',context),false);
 await vm.runInContext('loadDaemonLogs()',context);assert.equal(renders,1);
});
