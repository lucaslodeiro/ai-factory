import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8');
test('KPIs and controller share transitions; delayed snapshots and remote responses cannot roll them back',()=>{
 const nodes=new Map<string,any>();const get=(id:string)=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id)};
 const context=vm.createContext({$:get,document:{querySelectorAll:()=>[],title:''},escapeHtml:(v:any)=>String(v??''),relative:()=>'',brandIcon:()=>'',githubLink:()=>'',statusName:(v:any)=>v,stateClass:()=>'',applySettingsLock:()=>{},usageInitialized:false,expandedUsageItems:new Set(),settingsBusy:false,setupMode:false});
 vm.runInContext(source.split('\n').find(l=>l.startsWith('function metric('))!,context);
 vm.runInContext(source.slice(source.indexOf('let lastSnapshot=null;'),source.indexOf('\nasync function refresh()')),context);
 for(const name of ['renderSnapshotController','renderController'])vm.runInContext(source.split('\n').find(l=>l.startsWith(`function ${name}(`))!,context);
 const draw=(status:string,time:string,stalled=false)=>{context.data={generatedAt:time,items:[{id:'one',status,activity:{stalled}}],controller:{state:'active',displayName:'Factory A',generation:1},executions:[],events:[],daemon:{running:true}};vm.runInContext('render(data)',context)};
 draw('RUNNING','2026-09-20T12:00:01.000Z');assert.equal(get('#running-count').textContent,1);assert.match(get('#controller-description').textContent,/0 queued · 1 running/);
 draw('PAUSED','2026-09-20T12:00:02.000Z');assert.equal(get('#running-count').textContent,0);assert.equal(get('#paused-count').textContent,1);assert.match(get('#controller-description').textContent,/0 queued · 0 running/);
 draw('RUNNING','2026-09-20T12:00:01.000Z');assert.equal(get('#paused-count').textContent,1);assert.match(get('#controller-description').textContent,/0 queued · 0 running/);
 vm.runInContext("renderController({state:'active',record:{activeWorkCount:9},issues:[]})",context);assert.match(get('#controller-description').textContent,/0 queued · 0 running/);
 draw('RUNNING','2026-09-20T12:00:03.000Z',true);assert.equal(get('#running-count').textContent,0);assert.match(get('#controller-description').textContent,/0 queued · 0 running/);
 draw('FAILED','2026-09-20T12:00:04.000Z');assert.equal(get('#failed-count').textContent,1);assert.match(get('#controller-description').textContent,/0 queued · 0 running/);
 draw('QUEUED','2026-09-20T12:00:05.000Z');assert.equal(get('#queued-count').textContent,1);assert.equal(get('#running-count').textContent,0);assert.match(get('#controller-description').textContent,/1 queued · 0 running/);
 draw('CANCELLED','2026-09-20T12:00:06.000Z');assert.equal(get('#cancelled-count').textContent,1);assert.equal(get('#failed-count').textContent,0);
 draw('COMPLETED','2026-09-20T12:00:07.000Z');assert.equal(get('#completed-count').textContent,1);assert.equal(get('#cancelled-count').textContent,0);
 draw('WAITING','2026-09-20T12:00:08.000Z');assert.equal(get('#waiting-count').textContent,1);assert.equal(get('#completed-count').textContent,0);

});
