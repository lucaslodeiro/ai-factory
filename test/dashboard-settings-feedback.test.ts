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
