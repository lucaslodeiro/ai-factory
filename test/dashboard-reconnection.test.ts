import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source=fs.readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8');
function dashboard(interrupted:boolean,fetch:()=>Promise<unknown>){
 const elements=new Map<string,any>(),toasts:string[]=[],storage=new Map<string,string>();
 if(interrupted)storage.set('factory-api-interruption',String(Date.now()+30000));
 const context=vm.createContext({fetch,Date,Promise,AbortSignal,sessionStorage:{getItem:(key:string)=>storage.get(key),setItem:(key:string,value:string)=>storage.set(key,value)},$: (selector:string)=>{if(!elements.has(selector))elements.set(selector,{textContent:'',innerHTML:'previous data',classList:{remove(){}}});return elements.get(selector)},toast:(message:string)=>toasts.push(message),escapeHtml:(value:string)=>value,credentialsData:{credentials:[]},settingsLoaded:false,render(){},renderSettings(){},renderCredentials(){},renderSlack(){},renderServices(){}});
 vm.runInContext(source.slice(source.indexOf('let factoryUpdating='),source.indexOf('async function prepareMaintenance')),context);
 for(const name of ['refresh','loadCredentials','loadSlack','loadSettings','loadServices'])vm.runInContext(source.split('\n').find(line=>line.startsWith(`async function ${name}(`))!,context);
 return {context,elements,toasts,run:(name:string)=>vm.runInContext(`${name}()`,context)};
}
test('all background reads reconnect quietly during an update, including after a page reload',async()=>{
 const ui=dashboard(true,async()=>{throw new TypeError('Failed to fetch')});
 for(const name of ['refresh','loadCredentials','loadSlack','loadSettings','loadServices'])await ui.run(name);
 assert.deepEqual(ui.toasts,[]);assert.equal(ui.elements.get('#live-status').textContent,'Reconnecting');
 assert.equal(ui.elements.has('#credentials-list'),false);assert.equal(ui.elements.has('#slack-connection'),false);
});
test('network failures outside maintenance remain visible',async()=>{
 const ui=dashboard(false,async()=>{throw new TypeError('Failed to fetch')});await ui.run('loadSettings');assert.deepEqual(ui.toasts,['Failed to fetch']);
});
test('HTTP errors during maintenance are not mistaken for reconnects',async()=>{
 const ui=dashboard(true,async()=>({ok:false,json:async()=>({error:'Configuration invalid'})}));await ui.run('loadSettings');assert.deepEqual(ui.toasts,['Configuration invalid']);
});
test('interrupted response bodies reconnect and subsequent polls recover',async()=>{
 let disconnected=true;
 const ui=dashboard(true,async()=>({ok:true,json:async()=>{if(disconnected)throw new TypeError('Load failed');return {credentials:[]}}}));
 await ui.run('loadSettings');assert.deepEqual(ui.toasts,[]);disconnected=false;let renders=0;ui.context.renderSettings=()=>renders++;await ui.run('loadSettings');assert.equal(renders,1);
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

test('update diagnostics stay outside the status badge and clear after recovery',()=>{
 const ui=dashboard(false,async()=>({}));
 vm.runInContext('let updatePreparing=false;let serviceBusy=false;let daemonStartAttention=false;',ui.context);
 vm.runInContext(source.split('\n').find(line=>line.startsWith('function renderServices('))!,ui.context);
 const detail='Update failed while validating the candidate installation: /very/long/path/'.repeat(30);
 ui.context.data={services:[],update:{status:'failed',phase:detail}};
 vm.runInContext('renderServices(data)',ui.context);
 assert.equal(ui.elements.get('#update-status').textContent,'Update failed');
 assert.equal(ui.elements.get('#update-detail-text').textContent,detail);
 assert.equal(ui.elements.get('#update-details').hidden,false);
 ui.context.data={services:[],update:{status:'completed'}};
 vm.runInContext('renderServices(data)',ui.context);
 assert.equal(ui.elements.get('#update-details').hidden,true);
 assert.equal(ui.elements.get('#update-detail-text').textContent,'');
});
