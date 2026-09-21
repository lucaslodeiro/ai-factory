import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source=fs.readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8');
function dashboard(interrupted:boolean,fetch:(...args:any[])=>Promise<unknown>){
 const elements=new Map<string,any>(),toasts:string[]=[],storage=new Map<string,string>();
 if(interrupted)storage.set('factory-api-interruption',String(Date.now()+30000));
 const context=vm.createContext({fetch,Date,Promise,AbortSignal,AbortController,setTimeout,clearTimeout,sessionStorage:{getItem:(key:string)=>storage.get(key),setItem:(key:string,value:string)=>storage.set(key,value)},$: (selector:string)=>{if(!elements.has(selector))elements.set(selector,{textContent:'',innerHTML:'previous data',classList:{remove(){}}});return elements.get(selector)},toast:(message:string)=>toasts.push(message),escapeHtml:(value:string)=>value,credentialsData:{credentials:[]},settingsLoaded:false,settingsLoadPromise:null,render(){},renderSettings(){},renderCredentials(){},renderSlack(){},renderServices(){}});
 vm.runInContext(source.slice(source.indexOf('let factoryUpdating='),source.indexOf('async function prepareMaintenance')),context);
 for(const name of ['settingsLoadFailure','refresh','loadCredentials','loadSlack','loadSettings','loadServices'])vm.runInContext(source.split('\n').find(line=>line.startsWith(`${name==='settingsLoadFailure'?'function':'async function'} ${name}(`))!,context);
 return {context,elements,toasts,run:(name:string)=>vm.runInContext(`${name}()`,context)};
}
test('all background reads reconnect quietly during an update, including after a page reload',async()=>{
 const ui=dashboard(true,async()=>{throw new TypeError('Failed to fetch')});
 for(const name of ['refresh','loadCredentials','loadSlack','loadSettings','loadServices'])await ui.run(name);
 assert.deepEqual(ui.toasts,[]);assert.equal(ui.elements.get('#live-status').textContent,'Reconnecting');
 assert.equal(ui.elements.has('#credentials-list'),false);assert.equal(ui.elements.has('#slack-connection'),false);
});
test('network failures outside maintenance remain visible',async()=>{
 const ui=dashboard(false,async()=>{throw new TypeError('Failed to fetch')});await ui.run('loadSettings');assert.deepEqual(ui.toasts,['Failed to fetch']);assert.match(ui.elements.get('#settings-groups').innerHTML,/Configuration could not be loaded/);assert.match(ui.elements.get('#settings-groups').innerHTML,/Retry/);
});
test('HTTP errors during maintenance are not mistaken for reconnects',async()=>{
 const ui=dashboard(true,async()=>({ok:false,json:async()=>({error:'Configuration invalid'})}));await ui.run('loadSettings');assert.deepEqual(ui.toasts,['Configuration invalid']);
});
test('interrupted response bodies reconnect and subsequent polls recover',async()=>{
 let disconnected=true;
 const ui=dashboard(true,async()=>({ok:true,json:async()=>{if(disconnected)throw new TypeError('Load failed');return {credentials:[]}}}));
 await ui.run('loadSettings');assert.deepEqual(ui.toasts,[]);disconnected=false;let renders=0;ui.context.renderSettings=()=>renders++;await ui.run('loadSettings');assert.equal(renders,1);
});
test('configuration renders without waiting for optional integration reads',async()=>{
 let credentialsRequested=false,slackRequested=false,renders=0;
 const ui=dashboard(false,async(url:string)=>{if(url==='/api/settings')return {ok:true,json:async()=>({fields:[]})};if(url==='/api/credentials')credentialsRequested=true;if(url==='/api/slack')slackRequested=true;return new Promise(()=>{})});
 ui.context.renderSettings=()=>renders++;await ui.run('loadSettings');assert.equal(renders,1);assert.equal(credentialsRequested,true);assert.equal(slackRequested,true);
});
test('concurrent configuration refreshes share one request',async()=>{
 const calls:string[]=[];let release!:(value:any)=>void;const pending=new Promise(resolve=>{release=resolve});const ui=dashboard(false,async(url:string)=>{calls.push(url);if(url==='/api/settings')return pending;return {ok:true,json:async()=>url==='/api/credentials'?{credentials:[]}:{configured:false}}});
 const first=ui.run('loadSettings'),second=ui.run('loadSettings');assert.deepEqual(calls,['/api/settings']);release({ok:true,json:async()=>({fields:[]})});await Promise.all([first,second]);assert.equal(calls.filter(url=>url==='/api/settings').length,1);
});

test('repeated update clicks during asynchronous preparation submit only once',async()=>{
 let release!:(value:string)=>void,preparations=0,submissions=0;
 const pending=new Promise<string>(resolve=>{release=resolve;});
 const ui=dashboard(false,async()=>{submissions++;return {ok:true,json:async()=>({message:'Started',update:{status:'updating'}})}});
 ui.context.prepareMaintenance=()=>{preparations++;return pending;};
 vm.runInContext("let updatePreparing=false;updateCheck={available:true};",ui.context);
 vm.runInContext(source.split('\n').find(line=>line.startsWith('async function updateFactory('))!,ui.context);
 const first=ui.run('updateFactory');await ui.run('updateFactory');assert.equal(preparations,1);assert.equal(submissions,0);
 release('maintenance-id');await first;assert.equal(submissions,1);
});

test('a persisted updating state clears an earlier preparation error from the badge',()=>{
 const ui=dashboard(false,async()=>({}));
 ui.context.relative=()=> 'just now';
 vm.runInContext('updatePreparing=false;serviceBusy=false;daemonStartAttention=false;updatePreparationError="Update request did not start";',ui.context);
 vm.runInContext(source.split('\n').find(line=>line.startsWith('function renderServices('))!,ui.context);
 ui.context.data={services:[],update:{status:'updating',phase:'Downloading and validating…',startedAt:new Date().toISOString()}};
 vm.runInContext('renderServices(data)',ui.context);
 assert.equal(ui.elements.get('#update-status').textContent,'Updating…');
 assert.equal(vm.runInContext('updatePreparationError',ui.context),'');
});

test('update diagnostics stay outside the status badge and clear after recovery',()=>{
 const ui=dashboard(false,async()=>({}));
 vm.runInContext('let updatePreparing=false;let serviceBusy=false;let daemonStartAttention=false;',ui.context);
 vm.runInContext("const operationFailures=new Map();",ui.context);
 vm.runInContext(source.split('\n').find(line=>line.startsWith('function rememberFailure('))!,ui.context);
 vm.runInContext(source.split('\n').find(line=>line.startsWith('function renderServices('))!,ui.context);
 const detail='Update failed while validating the candidate installation: /very/long/path/'.repeat(30);
 ui.context.data={services:[],update:{status:'failed',phase:detail}};
 vm.runInContext('renderServices(data)',ui.context);
 assert.equal(ui.elements.get('#update-status').textContent,'Update failed');
 assert.equal(ui.elements.get('#update-detail-text').textContent,detail);
 assert.equal(ui.elements.get('#update-details').hidden,false);
 assert.equal(ui.elements.get('#update-diagnose').hidden,false);
 ui.context.data={services:[],update:{status:'completed'}};
 vm.runInContext('renderServices(data)',ui.context);
 assert.equal(ui.elements.get('#update-details').hidden,true);
 assert.equal(ui.elements.get('#update-diagnose').hidden,true);
 assert.equal(ui.elements.get('#update-detail-text').textContent,'');
});

function updateUi(fetch:()=>Promise<unknown>){
 const ui=dashboard(false,fetch);
 vm.runInContext("let updatePreparing=false;updateCheck={available:true};",ui.context);
 for(const name of ['updateFactory','prepareMaintenance','checkForUpdates'])vm.runInContext(source.split('\n').find(line=>line.startsWith(`async function ${name}(`))!,ui.context);
 return ui;
}
test('preparation immediately reports progress and preserves failure details while unlocking',async()=>{
 const ui=updateUi(async()=>{throw new Error('Dashboard unavailable')});
 await ui.run('updateFactory');
 assert.equal(ui.toasts[0],'Preparing update…');
 assert.equal(vm.runInContext('updatePreparing',ui.context),false);
 assert.equal(vm.runInContext('updatePreparationError',ui.context),'Dashboard unavailable');
 assert.equal(vm.runInContext('factoryUpdating',ui.context),false);
});
test('maintenance request bounds a stalled response body and aborts the request',async()=>{
 const ui=dashboard(false,async()=>({ok:true,json:()=>new Promise(()=>{})}));
 await assert.rejects(vm.runInContext("maintenanceRequest('/test',{},5)",ui.context),/did not respond in time/);
});
test('maintenance polling surfaces HTTP errors instead of waiting for the deadline',async()=>{
 let calls=0;
 const ui=updateUi(async()=>{calls++;return {ok:calls<3,json:async()=>calls===1?{id:'test',affected:[]}:calls===2?{ok:true}:{error:'Unknown maintenance operation'}}});
 await ui.run('updateFactory');
 assert.equal(calls,3);
 assert.equal(vm.runInContext('updatePreparationError',ui.context),'Unknown maintenance operation');
 assert.equal(vm.runInContext('updatePreparing',ui.context),false);
});
test('user cancellation does not confirm maintenance or start the update',async()=>{
 let calls=0;
 const ui=updateUi(async()=>{calls++;return {ok:true,json:async()=>({id:'test',affected:[{issueNumber:2,title:'Test',stage:'BUILD',status:'RUNNING'}]})}});
 ui.context.confirm=()=>false;ui.context.statusName=(value:string)=>value;
 await ui.run('updateFactory');
 assert.equal(calls,1);assert.equal(vm.runInContext('updatePreparing',ui.context),false);
 assert.equal(vm.runInContext('updatePreparationError',ui.context),'Operation cancelled.');
});
