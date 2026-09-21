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
 const context=vm.createContext({$:get,document:{querySelectorAll:()=>[]},escapeHtml:(v:any)=>String(v??''),relative:()=> 'just now',brandIcon:()=>'',githubLink:(_url:string,label:string)=>label,statusName:(v:any)=>v,stateClass:()=>'',loadWorkflowThread:()=>{}});
 const start=source.indexOf('function renderIssueList('),end=source.indexOf('\nasync function refresh()',start);
 vm.runInContext("const pendingControls=new Map(),threadDrafts=new Map(),threadScroll=new Map(),expandedWorkDetails=new Set(),collapsedWorkDetails=new Set();let remoteIssueData=null,remoteIssueCheckedAt=null,remoteIssueError='',lastSnapshot=null,lastIssueListSignature='';",context);vm.runInContext(source.split('\n').find(line=>line.startsWith('function workDetails('))!,context);vm.runInContext(source.slice(start,end),context);vm.runInContext(source.split('\n').find(line=>line.startsWith('function renderRemoteIssues('))!,context);
 context.local={repository:'owner/demo',controller:{state:'active'},items:[{id:'local',issue:2,title:'Local title',stage:'REVIEW',status:'RUNNING',actions:['pause','cancel'],continuity:{instance:'old-mac',revision:9}}]};vm.runInContext('lastSnapshot=local;renderIssueList(local)',context);
 context.remote={repository:'owner/demo',issues:[{number:2,title:'Stale GitHub title',status:'FAILED',stage:'TEST',ownership:'here',instances:['local']},{number:7,title:'Remote only',status:'WAITING',stage:'DESIGN',ownership:'other',instances:['other'],canWorkHere:true},{number:8,title:'Active elsewhere',status:'active',stage:'BUILD',ownership:'here',instances:['local'],continuationState:'continuation-waiting',sourceInstance:'old-mac',canContinue:true}]};vm.runInContext('renderRemoteIssues(remote)',context);
 assert.match(get('#items').innerHTML,/Local title/);assert.match(get('#items').innerHTML,/Continued from old-mac at revision 9/);assert.doesNotMatch(get('#items').innerHTML,/Stale GitHub title/);assert.match(get('#items').innerHTML,/REVIEW · RUNNING/);assert.match(get('#items').innerHTML,/Remote only/);assert.match(get('#items').innerHTML,/On other/);assert.match(get('#items').innerHTML,/Work here/);assert.match(get('#items').innerHTML,/Waiting to continue from old-mac/);assert.match(get('#items').innerHTML,/Continue anyway/);assert.equal((get('#items').innerHTML.match(/factoryControl\(/g)||[]).length,2);
 context.local.items.push({id:'new',issue:7,title:'Now local',stage:'BUILD',status:'QUEUED',actions:['pause','cancel']});vm.runInContext('renderIssueList(local)',context);assert.doesNotMatch(get('#items').innerHTML,/Remote only|On other/);assert.match(get('#items').innerHTML,/Now local/);
 context.local.items[0].control={id:1,kind:'pause',pending:true};vm.runInContext('renderIssueList(local)',context);assert.match(get('#items').innerHTML,/pause requested/);assert.match(get('#items').innerHTML,/<button disabled/);
 context.local.controller.state='uncertain';vm.runInContext('renderIssueList(local)',context);assert.match(get('#items').innerHTML,/factoryControl\(/);
 context.local.repository='owner/other';context.local.items=[];vm.runInContext('renderIssueList(local)',context);assert.doesNotMatch(get('#items').innerHTML,/Remote only/);
});

test('unchanged issue snapshots do not repaint the list',()=>{
 let paints=0,html='';const itemsNode={get innerHTML(){return html},set innerHTML(value){html=value;paints++}},statusNode:any={};const context=vm.createContext({$:(id:string)=>id==='#items'?itemsNode:statusNode,document:{querySelectorAll:()=>[]},escapeHtml:(v:any)=>String(v??''),relative:()=> 'now',brandIcon:()=>'',githubLink:(_url:string,label:string)=>label,statusName:(v:any)=>v,stateClass:()=>'',loadWorkflowThread:()=>{}});const start=source.indexOf('function renderIssueList('),end=source.indexOf('\nasync function refresh()',start);vm.runInContext("const pendingControls=new Map(),threadDrafts=new Map(),threadScroll=new Map(),expandedWorkDetails=new Set(),collapsedWorkDetails=new Set();let remoteIssueData=null,remoteIssueCheckedAt=null,remoteIssueError='',lastIssueListSignature='';",context);vm.runInContext(source.split('\n').find(line=>line.startsWith('function workDetails('))!,context);vm.runInContext(source.slice(start,end),context);context.snapshot={repository:'owner/demo',items:[{id:'w',issue:1,title:'Stable',stage:'DESIGN',status:'FAILED',attempt:0,actions:['retry'],activity:{diagnosis:{summary:'Cause',evidence:'Evidence',nextAction:'Retry'}}}]};vm.runInContext('renderIssueList(snapshot);renderIssueList(snapshot)',context);assert.equal(paints,1);
});
