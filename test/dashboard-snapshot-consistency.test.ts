import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8');
test('KPIs reflect live transitions; delayed snapshots and remote responses cannot roll them back',()=>{
 const nodes=new Map<string,any>();const get=(id:string)=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id)};
 const context=vm.createContext({$:get,document:{querySelectorAll:()=>[],title:''},escapeHtml:(v:any)=>String(v??''),relative:()=>'',brandIcon:()=>'',githubLink:()=>'',statusName:(v:any)=>v,stateClass:()=>'',applySettingsLock:()=>{},usageInitialized:false,expandedUsageItems:new Set(),settingsBusy:false,setupMode:false});
 vm.runInContext(source.split('\n').find(l=>l.startsWith('function metric('))!,context);
 vm.runInContext(source.slice(source.indexOf('let lastSnapshot=null;'),source.indexOf('\nasync function refresh()')),context);
 for(const name of ['renderRemoteIssues'])vm.runInContext(source.split('\n').find(l=>l.startsWith(`function ${name}(`))!,context);
 const draw=(status:string,time:string,stalled=false)=>{context.data={generatedAt:time,items:[{id:'one',status,activity:{stalled}}],controller:{state:'active',displayName:'Factory A',generation:1},executions:[],events:[],daemon:{running:true}};vm.runInContext('render(data)',context)};
 draw('RUNNING','2026-09-20T12:00:01.000Z');assert.equal(get('#running-count').textContent,1);
 draw('PAUSED','2026-09-20T12:00:02.000Z');assert.equal(get('#running-count').textContent,0);assert.equal(get('#paused-count').textContent,1);
 draw('RUNNING','2026-09-20T12:00:01.000Z');assert.equal(get('#paused-count').textContent,1);
 vm.runInContext("renderRemoteIssues({state:'active',record:{activeWorkCount:9},issues:[]})",context);
 draw('RUNNING','2026-09-20T12:00:03.000Z',true);assert.equal(get('#running-count').textContent,0);
 draw('FAILED','2026-09-20T12:00:04.000Z');assert.equal(get('#failed-count').textContent,1);
 draw('QUEUED','2026-09-20T12:00:05.000Z');assert.equal(get('#queued-count').textContent,1);assert.equal(get('#running-count').textContent,0);
 draw('CANCELLED','2026-09-20T12:00:06.000Z');assert.equal(get('#cancelled-count').textContent,1);assert.equal(get('#failed-count').textContent,0);
 draw('COMPLETED','2026-09-20T12:00:07.000Z');assert.equal(get('#completed-count').textContent,1);assert.equal(get('#cancelled-count').textContent,0);
 draw('WAITING','2026-09-20T12:00:08.000Z');assert.equal(get('#waiting-count').textContent,1);assert.equal(get('#completed-count').textContent,0);

});

test('unified issue list deduplicates GitHub rows and never replaces live local state',()=>{
 const nodes=new Map<string,any>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id)};
 const context=vm.createContext({$:get,document:{querySelectorAll:()=>[]},escapeHtml:(v:any)=>String(v??''),applyQueueAvailability:()=>{},relative:()=> 'just now',brandIcon:()=>'',githubLink:(_url:string,label:string)=>label,statusName:(v:any)=>v,stateClass:()=>'',loadWorkflowThread:()=>{}});
 const start=source.indexOf('function renderIssueList('),end=source.indexOf('\nasync function refresh()',start);
 vm.runInContext("const pendingControls=new Map(),threadDrafts=new Map(),expandedWorkDetails=new Set(),collapsedWorkDetails=new Set();let remoteIssueData=null,remoteIssueCheckedAt=null,remoteIssueError='',lastSnapshot=null,lastIssueListSignature='';",context);vm.runInContext(source.split('\n').find(line=>line.startsWith('function promptReadableHtml('))!,context);vm.runInContext(source.split('\n').find(line=>line.startsWith('function workDetails('))!,context);vm.runInContext(source.slice(start,end),context);vm.runInContext(source.split('\n').find(line=>line.startsWith('function renderRemoteIssues('))!,context);
 context.local={repository:'owner/demo',controller:{state:'active'},items:[{id:'local',issue:2,title:'Local title',stage:'REVIEW',status:'RUNNING',actions:['pause','cancel'],continuity:{instance:'old-mac',revision:9}}]};vm.runInContext('lastSnapshot=local;renderIssueList(local)',context);
 context.remote={repository:'owner/demo',issues:[{number:2,title:'Stale GitHub title',status:'FAILED',stage:'TEST',ownership:'here',instances:['local']},{number:7,title:'Remote only',status:'WAITING',stage:'DESIGN',ownership:'other',instances:['other'],canWorkHere:true},{number:8,title:'Active elsewhere',status:'active',stage:'BUILD',ownership:'here',instances:['local'],continuationState:'continuation-waiting',sourceInstance:'old-mac',canContinue:true}]};vm.runInContext('renderRemoteIssues(remote)',context);
 assert.match(get('#items').innerHTML,/Local title/);assert.match(get('#items').innerHTML,/Continued from old-mac at revision 9/);assert.doesNotMatch(get('#items').innerHTML,/Stale GitHub title/);assert.match(get('#items').innerHTML,/REVIEW · RUNNING/);assert.match(get('#items').innerHTML,/Remote only/);assert.match(get('#items').innerHTML,/On other/);assert.match(get('#items').innerHTML,/Work here/);assert.match(get('#items').innerHTML,/Waiting to continue from old-mac/);assert.match(get('#items').innerHTML,/Continue anyway/);assert.equal((get('#items').innerHTML.match(/factoryControl\(/g)||[]).length,2);
 context.local.items.push({id:'new',issue:7,title:'Now local',stage:'BUILD',status:'QUEUED',actions:['pause','cancel']});vm.runInContext('renderIssueList(local)',context);assert.doesNotMatch(get('#items').innerHTML,/Remote only|On other/);assert.match(get('#items').innerHTML,/Now local/);
 context.local.items[0].control={id:1,kind:'pause',pending:true};vm.runInContext('renderIssueList(local)',context);assert.match(get('#items').innerHTML,/pause requested/);assert.match(get('#items').innerHTML,/<button disabled/);
 context.local.controller.state='uncertain';vm.runInContext('renderIssueList(local)',context);assert.match(get('#items').innerHTML,/factoryControl\(/);
 context.local.repository='owner/other';context.local.items=[];vm.runInContext('renderIssueList(local)',context);assert.doesNotMatch(get('#items').innerHTML,/Remote only/);
});

test('unchanged issue snapshots do not repaint the list',()=>{
 let paints=0,html='';const itemsNode={get innerHTML(){return html},set innerHTML(value){html=value;paints++}},statusNode:any={};const context=vm.createContext({$:(id:string)=>id==='#items'?itemsNode:statusNode,document:{querySelectorAll:()=>[]},escapeHtml:(v:any)=>String(v??''),relative:()=> 'now',brandIcon:()=>'',githubLink:(_url:string,label:string)=>label,statusName:(v:any)=>v,stateClass:()=>'',loadWorkflowThread:()=>{}});const start=source.indexOf('function renderIssueList('),end=source.indexOf('\nasync function refresh()',start);vm.runInContext("const pendingControls=new Map(),threadDrafts=new Map(),expandedWorkDetails=new Set(),collapsedWorkDetails=new Set();let remoteIssueData=null,remoteIssueCheckedAt=null,remoteIssueError='',lastIssueListSignature='';",context);vm.runInContext(source.split('\n').find(line=>line.startsWith('function promptReadableHtml('))!,context);vm.runInContext(source.split('\n').find(line=>line.startsWith('function workDetails('))!,context);vm.runInContext(source.slice(start,end),context);context.snapshot={repository:'owner/demo',items:[{id:'w',issue:1,title:'Stable',stage:'DESIGN',status:'FAILED',attempt:0,actions:['retry'],activity:{diagnosis:{summary:'Cause',evidence:'Evidence',nextAction:'Retry'}}}]};vm.runInContext('renderIssueList(snapshot);renderIssueList(snapshot)',context);assert.equal(paints,1);
});

test('live progress changes its line without repainting the issue card or its composer',()=>{
 let paints=0,html='';const line:any={dataset:{workProgress:'w'},textContent:'',classList:{toggle(){}}};
 const itemsNode={get innerHTML(){return html},set innerHTML(value:string){html=value;paints++;}};
 const context=vm.createContext({$:(id:string)=>id==='#items'?itemsNode:{},document:{querySelectorAll:(selector:string)=>selector==='[data-work-progress]'?[line]:[]},escapeHtml:(v:any)=>String(v??''),relative:()=> 'now',brandIcon:()=>'',githubLink:(_url:string,label:string)=>label,statusName:(v:any)=>v,stateClass:()=>'',loadWorkflowThread:()=>{}});
 vm.runInContext("const pendingControls=new Map(),threadDrafts=new Map(),expandedWorkDetails=new Set(),collapsedWorkDetails=new Set();let remoteIssueData=null,remoteIssueCheckedAt=null,remoteIssueError='',lastIssueListSignature='';",context);
 vm.runInContext(source.split('\n').find(text=>text.startsWith('function promptReadableHtml('))!,context);
 vm.runInContext(source.split('\n').find(text=>text.startsWith('function workDetails('))!,context);
 vm.runInContext(source.slice(source.indexOf('function renderIssueList('),source.indexOf('\nasync function refresh()')),context);
 context.snapshot={repository:'owner/demo',items:[{id:'w',issue:1,title:'In progress',stage:'TEST',status:'RUNNING',revision:1,attempt:1,activity:{label:'Agent running',detail:'Read is running',since:'now'}}]};
 vm.runInContext('renderIssueList(snapshot)',context);context.snapshot.items[0].activity.detail='Bash is running';vm.runInContext('renderIssueList(snapshot)',context);
 assert.equal(paints,1);assert.match(line.textContent,/Bash is running/);
});

test('snapshot preserves a composer draft and skips unchanged issue lists',()=>{
 const nodes=new Map<string,any>(),textarea={value:''};let writes=0,forms:any[]=[];
 const items={get innerHTML(){return ''},set innerHTML(_value:string){writes++;forms=[];}};
 const get=(id:string)=>{if(id==='#items')return items;if(!nodes.has(id))nodes.set(id,{});return nodes.get(id)};
 const document={activeElement:null as any,querySelectorAll:(selector:string)=>selector==='#items .thread-composer'?forms:[]};
 const context=vm.createContext({$:get,document,escapeHtml:(v:any)=>String(v??''),relative:()=>'',brandIcon:()=>'',githubLink:()=>'',statusName:(v:any)=>v,stateClass:()=>''});
 vm.runInContext("const pendingControls=new Map(),threadDrafts=new Map(),expandedWorkDetails=new Set(),collapsedWorkDetails=new Set();let remoteIssueData=null,remoteIssueCheckedAt=null,remoteIssueError='',lastIssueListSignature='';",context);
 vm.runInContext(source.split('\n').find(line=>line.startsWith('function promptReadableHtml('))!,context);vm.runInContext(source.split('\n').find(line=>line.startsWith('function workDetails('))!,context);
 vm.runInContext(source.slice(source.indexOf('function renderIssueList('),source.indexOf('\nasync function refresh()')),context);
 context.data={items:[{id:'one',revision:1,status:'RUNNING'}]};vm.runInContext('renderIssueList(data)',context);assert.equal(writes,1);
 vm.runInContext('renderIssueList(data)',context);assert.equal(writes,1);
 const form={contains:(element:any)=>element===textarea,querySelector:()=>textarea};forms=[form];textarea.value='Keep this guidance';context.data.items[0].revision=2;
 vm.runInContext('renderIssueList(data)',context);assert.equal(writes,1);assert.equal(forms[0].querySelector(),textarea);assert.equal(textarea.value,'Keep this guidance');assert.equal(get('#list-writing-note').hidden,false);
 textarea.value='';document.activeElement=textarea;vm.runInContext('renderIssueList(data)',context);assert.equal(writes,1);
 document.activeElement=null;vm.runInContext('renderIssueList(data)',context);assert.equal(writes,2);assert.equal(get('#list-writing-note').hidden,true);
});

test('stopped daemon controls recover without adding status noise to the issue list',()=>{
 const button={disabled:false,dataset:{}},readonly={disabled:true,dataset:{}};
 const context=vm.createContext({document:{querySelectorAll:()=>[button,readonly]}});
 vm.runInContext(source.slice(source.indexOf('let lastSnapshot=null;'),source.indexOf('const pendingControls=')),context);
 vm.runInContext('lastSnapshot={daemon:{running:false}};applyQueueAvailability();applyQueueAvailability()',context);
 assert.equal(button.disabled,true);assert.equal(readonly.disabled,true);
 vm.runInContext('lastSnapshot.daemon.running=true;applyQueueAvailability()',context);
 assert.equal(button.disabled,false);assert.equal(readonly.disabled,true);
});

test('an open thread with a lagging status comment reloads after each GitHub cycle and when the daemon stops',()=>{
 const nodes=new Map<string,any>();const get=(id:string)=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id)};const reloads:string[]=[];
 const context=vm.createContext({$:get,document:{querySelectorAll:()=>[],querySelector:()=>({open:true}),title:''},CSS:{escape:String},escapeHtml:(v:any)=>String(v??''),relative:()=>'',brandIcon:()=>'',githubLink:()=>'',statusName:(v:any)=>v,stateClass:()=>'',applySettingsLock:()=>{},usageInitialized:false,expandedUsageItems:new Set(),settingsBusy:false,setupMode:false});
 vm.runInContext(source.split('\n').find(l=>l.startsWith('function metric('))!,context);vm.runInContext(source.slice(source.indexOf('let lastSnapshot=null;'),source.indexOf('\nasync function refresh()')),context);for(const name of ['renderRemoteIssues'])vm.runInContext(source.split('\n').find(l=>l.startsWith(`function ${name}(`))!,context);
 vm.runInContext("threadCache.set('one',{publication:{behind:true,error:'HTTP 502'}});threadCache.set('two',{publication:{behind:false,error:null}})",context);context.recordReload=(id:string)=>{reloads.push(id)};vm.runInContext('loadWorkflowThread=(id)=>recordReload(id)',context);
 let tick=0;const draw=(sync:any,running=true)=>{context.data={generatedAt:`2026-09-22T00:00:${String(++tick).padStart(2,'0')}Z`,items:[{id:'one',status:'WAITING',revision:1,lastEventId:5},{id:'two',status:'WAITING',revision:1,lastEventId:7}],executions:[],events:[],daemon:{running},githubSync:sync};vm.runInContext('render(data)',context)};
 draw({state:'failed',at:'a'});reloads.length=0;
 draw({state:'syncing',at:'b'});assert.deepEqual(reloads,['one'],'only the lagging thread reloads on a new cycle');
 draw({state:'syncing',at:'b'});assert.deepEqual(reloads,['one'],'an unchanged cycle does not reload');
 draw({state:'syncing',at:'b'},false);assert.deepEqual(reloads,['one','one'],'a stopped daemon reloads the lagging thread');
});
