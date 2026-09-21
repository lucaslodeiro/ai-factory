import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Workspaces,git} from '../src/worktrees.js';
const branch='factory/verification';
function fixture(run:(root:string,ws:Workspaces)=>void){const root=fs.mkdtempSync(path.join(os.tmpdir(),'factory-verification-'));try{git(root,['init']);git(root,['config','user.name','Test']);git(root,['config','user.email','test@example.test']);fs.writeFileSync(path.join(root,'app.ts'),'production');fs.mkdirSync(path.join(root,'evidence'));fs.writeFileSync(path.join(root,'evidence/old.json'),'{}');git(root,['add','.']);git(root,['commit','-m','base']);git(root,['checkout','-b',branch]);run(root,new Workspaces());}finally{fs.rmSync(root,{recursive:true,force:true})}}
function write(root:string,file:string,text='report'){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text)}
test('QA accepts reports and screenshots without attributing or committing inherited evidence',()=>fixture((root,ws)=>{
 write(root,'evidence/inherited.md');const baseline=ws.capture(root);write(root,'evidence/qa-current.md');write(root,'evidence/lighthouse/es-1.json','{"score":100}');write(root,'evidence/page.png');
 const changed=ws.check(root,'qa',baseline.head,branch,baseline);assert.deepEqual(changed.sort(),['evidence/lighthouse/es-1.json','evidence/page.png','evidence/qa-current.md']);ws.commit(root,'verification',branch,changed);assert.equal(git(root,['ls-files','--others','--exclude-standard']),'evidence/inherited.md');assert.match(git(root,['show','--stat','HEAD']),/qa-current/);
 const retry=ws.capture(root);assert.deepEqual(ws.check(root,'qa',retry.head,branch,retry),[]);assert.doesNotThrow(()=>ws.check(root,'reviewer',retry.head,branch,retry));
}));
test('inherited production is identified separately and scoped commits preserve unrelated staged work',()=>fixture((root,ws)=>{
 write(root,'app.ts','inherited');git(root,['add','app.ts']);const baseline=ws.capture(root);write(root,'evidence/qa-current.md');assert.throws(()=>ws.check(root,'qa',baseline.head,branch,baseline),/Pre-existing.*not attributed.*app.ts/);
 ws.commit(root,'only evidence',branch,['evidence/qa-current.md']);assert.equal(git(root,['show','HEAD:app.ts']),'production');assert.equal(git(root,['diff','--cached','--name-only']),'app.ts');assert.equal(fs.readFileSync(path.join(root,'app.ts'),'utf8'),'inherited');
}));

test('QA rejects its own production, manifest, policy, executable and credential changes with filenames',()=>fixture((root,ws)=>{
 const baseline=ws.capture(root);
 for(const file of ['app.ts','evidence/run.js','evidence/tests/evil.js','evidence/package.json','evidence/.hidden.json','tests/package-lock.json','tests/.env','evidence/credentials.json','.factory/verification.json']){
  write(root,file,file.endsWith('json')?'{}':'changed');assert.throws(()=>ws.check(root,'qa',baseline.head,branch,baseline),error=>String(error).includes(file));if(file==='app.ts')write(root,file,'production');else fs.unlinkSync(path.join(root,file));
 }
 write(root,'evidence/report.md');fs.chmodSync(path.join(root,'evidence/report.md'),0o755);assert.throws(()=>ws.check(root,'qa',baseline.head,branch,baseline),/executable evidence.*report.md/);fs.unlinkSync(path.join(root,'evidence/report.md'));
 fs.symlinkSync(path.join(root,'app.ts'),path.join(root,'evidence/report.md'));assert.throws(()=>ws.check(root,'qa',baseline.head,branch,baseline),/links.*report.md/);
}));
test('QA accepts the Factory browser runner completion record as evidence',()=>fixture((root,ws)=>{
 const baseline=ws.capture(root);write(root,'evidence/browser/.last-run.json','{}');
 assert.deepEqual(ws.check(root,'qa',baseline.head,branch,baseline),['evidence/browser/.last-run.json']);
}));
test('changed inherited production and production renamed into tests cannot bypass validation',()=>fixture((root,ws)=>{
 write(root,'app.ts','inherited');const baseline=ws.capture(root);write(root,'app.ts','new QA edit');assert.throws(()=>ws.check(root,'qa',baseline.head,branch,baseline),/non-test.*app.ts/);write(root,'app.ts','inherited');fs.mkdirSync(path.join(root,'tests'));git(root,['mv','app.ts','tests/app.test.ts']);assert.throws(()=>ws.check(root,'qa',baseline.head,branch,baseline),/non-test.*app.ts/);
}));
test('project policy supports explicit evidence directories and test scripts and stays pinned for the run',()=>fixture((root,ws)=>{
 write(root,'.factory/verification.json',JSON.stringify({evidenceDirectories:['reports/qa'],testFiles:['scripts/verify.mjs']}));git(root,['add','.factory/verification.json']);git(root,['commit','-m','policy']);const baseline=ws.capture(root);write(root,'reports/qa/result.json','{}');write(root,'scripts/verify.mjs','test()');assert.equal(ws.check(root,'qa',baseline.head,branch,baseline).length,2);write(root,'evidence/unconfigured.md');assert.throws(()=>ws.check(root,'qa',baseline.head,branch,baseline),/unconfigured.md/);fs.unlinkSync(path.join(root,'evidence/unconfigured.md'));write(root,'.factory/verification.json','invalid JSON');assert.throws(()=>ws.check(root,'qa',baseline.head,branch,baseline),/non-test.*verification.json/);
}));
test('deleted evidence and unusual filenames are committed without staging unrelated files',()=>fixture((root,ws)=>{
 const baseline=ws.capture(root);fs.unlinkSync(path.join(root,'evidence/old.json'));write(root,'evidence/a[1]\nquote.md');const changed=ws.check(root,'qa',baseline.head,branch,baseline);ws.commit(root,'evidence update',branch,changed);assert.equal(git(root,['status','--porcelain']),'');assert.equal(git(root,['ls-tree','--name-only','HEAD','evidence/old.json']),'');
}));
test('Builder can finish its pending implementation across retries but cannot commit inherited credentials',()=>fixture((root,ws)=>{
 write(root,'app.ts','pending implementation');const baseline=ws.capture(root);const changed=ws.check(root,'developer',baseline.head,branch,baseline);assert.deepEqual(changed,['app.ts']);ws.commit(root,'complete implementation',branch,changed);assert.equal(git(root,['show','HEAD:app.ts']),'pending implementation');write(root,'credentials.json','secret');const retry=ws.capture(root);assert.throws(()=>ws.check(root,'developer',retry.head,branch,retry),/credential.*credentials.json/);
}));
