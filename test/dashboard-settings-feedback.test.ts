import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8');
test('settings progress stays beside the save button and exposes busy and completion states',()=>{
 const elements=new Map<string,any>();const context=vm.createContext({$:(key:string)=>{if(!elements.has(key))elements.set(key,{dataset:{},setAttribute(name:string,value:string){this[name]=value;}});return elements.get(key)}});
 vm.runInContext(source.split('\n').find(line=>line.startsWith('function settingsProgress('))!,context);
 vm.runInContext("settingsProgress('Validating…')",context);assert.equal(elements.get('#settings-save').textContent,'Applying…');assert.equal(elements.get('#settings-form')['aria-busy'],'true');
 vm.runInContext("settingsProgress('Saved.','success')",context);assert.equal(elements.get('#settings-progress').textContent,'Saved.');assert.equal(elements.get('#settings-progress').dataset.state,'success');assert.equal(elements.get('#settings-form')['aria-busy'],'false');
 vm.runInContext("settingsProgress('Could not save.','error')",context);assert.equal(elements.get('#settings-progress').dataset.state,'error');
});
test('Codex credentials include a visible provider name',()=>{
 const context=vm.createContext({escapeHtml:String,brandIcon:()=>'<img>',brandTitle:{codex:'Codex'},credentialBusy:false});
 for(const prefix of ['const brandLabel=','function credentialCards('])vm.runInContext(source.split('\n').find(line=>line.startsWith(prefix))!,context);
 const html=vm.runInContext("credentialCards({credentials:[{id:'codex',label:'Codex',status:'connected',installed:true,description:'Agents'}]})",context);
 assert.match(html,/<span>Codex<\/span>/);
});
test('failed issue details render a human-readable diagnosis and next action',()=>{
 const context=vm.createContext({escapeHtml:String,relative:()=>"now"});vm.runInContext(source.split('\n').find(line=>line.startsWith('function workDetails('))!,context);
 const html=vm.runInContext("workDetails({id:'w',activity:{label:'Failed',detail:'raw',diagnosis:{summary:'Required browser unavailable',evidence:'No browser',nextAction:'Restore it and retry'}}},new Set(['w']))",context);
 assert.match(html,/Failure diagnosis/);assert.match(html,/What happened/);assert.match(html,/Required browser unavailable/);assert.match(html,/What the system observed/);assert.match(html,/No browser/);assert.match(html,/What to do next/);assert.match(html,/Restore it and retry/);assert.doesNotMatch(html,/>raw</);
});
test('workflow refresh preserves the open prompt, draft and conversation scroll',()=>{
 let html='',rendered=false;const input:any={value:'',addEventListener(){}},thread:any={scrollTop:0},turn:any={open:true,dataset:{threadTurn:'w:1'},addEventListener(){}};const root:any={get innerHTML(){return html},set innerHTML(value){html=value;rendered=true},querySelector(selector:string){if(!rendered)return null;if(selector==='[data-thread-message]')return input;if(selector==='.workflow-thread')return thread;return null},querySelectorAll(selector:string){return rendered&&selector==='[data-thread-turn]'?[turn]:[]}};
 const context=vm.createContext({document:{querySelector:()=>root},CSS:{escape:String},escapeHtml:String,relative:()=> '1m ago',roleName:()=> 'Architect',statusName:String,stateClass:()=>'',actionLabel:{retry:'Retry with guidance'},sendWorkflowMessage(){},threadDrafts:new Map([['w','keep this guidance']]),threadScroll:new Map([['w',140]]),expandedThreadTurns:new Set(['w:1'])});const start=source.indexOf('function renderWorkflowThread('),end=source.indexOf('\nasync function loadWorkflowThread',start);vm.runInContext(source.slice(start,end),context);context.data={operator:{approver:true},actions:['retry'],turns:[{id:1,kind:'prompt',role:'product-architect',provider:'codex',model:'auto',available:true,executionId:'run',manifest:{sections:{Issue:20}}}]};vm.runInContext("renderWorkflowThread('w',data)",context);assert.match(html,/data-thread-turn="w:1" open/);assert.match(html,/Agent input/);assert.match(html,/Architect prompt/);assert.equal(input.value,'keep this guidance');assert.equal(thread.scrollTop,140);
});
